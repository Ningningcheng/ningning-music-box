// 歌词解析并加载
(() => {
	if (window.nncLyrics) {
		return;
	}
	const cache = new Map();
	const LRC_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
	const toUint8Array = async data => {
		if (!data) {
			return null;
		}
		if (data instanceof Uint8Array) {
			return data;
		}
		if (data instanceof ArrayBuffer) {
			return new Uint8Array(data);
		}
		if (ArrayBuffer.isView(data)) {
			return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		}
		if (data instanceof Blob) {
			return new Uint8Array(await data.arrayBuffer());
		}
		return null;
	};

	const decodeBytes = (bytes, encoding = "utf-8") => {
		if (!bytes?.length) {
			return "";
		}
		try {
			return new TextDecoder(encoding).decode(bytes);
		} catch (e) {
			let text = "";
			for (let i = 0; i < bytes.length; i++) {
				text += String.fromCharCode(bytes[i]);
			}
			return text;
		}
	};

	const decodeTextFile = bytes => {
		if (!bytes?.length) {
			return "";
		}
		if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
			return decodeBytes(bytes.subarray(3), "utf-8");
		}
		if (bytes[0] === 0xff && bytes[1] === 0xfe) {
			return decodeBytes(bytes.subarray(2), "utf-16le");
		}
		if (bytes[0] === 0xfe && bytes[1] === 0xff) {
			return decodeBytes(bytes.subarray(2), "utf-16be");
		}
		const utf8 = decodeBytes(bytes, "utf-8");
		const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
		if (!replacementCount || replacementCount / Math.max(1, utf8.length) < 0.01) {
			return utf8;
		}
		try {
			return new TextDecoder("gb18030").decode(bytes);
		} catch (e) {
			return utf8;
		}
	};

	const cleanText = text => String(text || "").replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();

	const normalizeLines = lines => {
		const result = [];
		const seen = new Set();
		for (const line of lines || []) {
			const time = Number(line?.time);
			const text = cleanText(line?.text).replace(/\s+/g, " ");
			if (!Number.isFinite(time) || time < 0 || !text) {
				continue;
			}
			const key = `${time.toFixed(3)}|${text}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			result.push({ time, text });
		}
		result.sort((a, b) => a.time - b.time);
		return result;
	};

	const parseLrc = text => {
		text = cleanText(text);
		if (!text) {
			return [];
		}
		let offset = 0;
		const offsetMatch = text.match(/\[offset:([+-]?\d+)\]/i);
		if (offsetMatch) {
			offset = Number(offsetMatch[1]) / 1000;
		}
		const lines = [];
		for (const rawLine of text.split("\n")) {
			const times = [];
			LRC_TIME.lastIndex = 0;
			let match;
			while ((match = LRC_TIME.exec(rawLine))) {
				const minute = Number(match[1]);
				const second = Number(match[2]);
				const fractionText = match[3] || "0";
				const fraction = Number(`0.${fractionText.padEnd(3, "0").slice(0, 3)}`);
				times.push(Math.max(0, minute * 60 + second + fraction + offset));
			}
			if (!times.length) {
				continue;
			}
			const content = cleanText(rawLine.replace(LRC_TIME, "")).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "");
			if (!content) {
				continue;
			}
			for (const time of times) {
				lines.push({ time, text: content });
			}
		}
		return normalizeLines(lines);
	};

	const readUInt24BE = (bytes, offset) => (
		(bytes[offset] << 16) |
		(bytes[offset + 1] << 8) |
		bytes[offset + 2]
	) >>> 0;

	const readUInt32BE = (bytes, offset) => (
		(bytes[offset] * 0x1000000) +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	) >>> 0;

	const readUInt32LE = (bytes, offset) => (
		bytes[offset] +
		(bytes[offset + 1] << 8) +
		(bytes[offset + 2] << 16) +
		(bytes[offset + 3] * 0x1000000)
	) >>> 0;

	const readSynchsafe = (bytes, offset) => (
		((bytes[offset] & 0x7f) << 21) |
		((bytes[offset + 1] & 0x7f) << 14) |
		((bytes[offset + 2] & 0x7f) << 7) |
		(bytes[offset + 3] & 0x7f)
	) >>> 0;

	const ascii = (bytes, start, length) => {
		let result = "";
		const end = Math.min(bytes.length, start + length);
		for (let i = start; i < end; i++) {
			result += String.fromCharCode(bytes[i]);
		}
		return result;
	};

	const removeUnsync = bytes => {
		const output = [];
		for (let i = 0; i < bytes.length; i++) {
			output.push(bytes[i]);
			if (bytes[i] === 0xff && bytes[i + 1] === 0x00) {
				i++;
			}
		}
		return new Uint8Array(output);
	};

	const getId3Encoding = byte => {
		switch (byte) {
			case 0:
				return { encoding: "windows-1252", unit: 1 };
			case 1:
				return { encoding: "utf-16", unit: 2 };
			case 2:
				return { encoding: "utf-16be", unit: 2 };
			default:
				return { encoding: "utf-8", unit: 1 };
		}
	};

	const readEncodedTerminated = (bytes, start, encodingByte) => {
		const info = getId3Encoding(encodingByte);
		let end = start;
		if (info.unit === 2) {
			while (end + 1 < bytes.length) {
				if (bytes[end] === 0 && bytes[end + 1] === 0) {
					break;
				}
				end += 2;
			}
		} else {
			while (end < bytes.length && bytes[end] !== 0) {
				end++;
			}
		}
		return {
			text: cleanText(decodeBytes(bytes.subarray(start, end), info.encoding)),
			next: Math.min(bytes.length, end + info.unit),
		};
	};

	const parseId3 = bytes => {
		if (!bytes || bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") {
			return null;
		}
		const version = bytes[3];
		const flags = bytes[5];
		let tag = bytes.subarray(10, Math.min(bytes.length, 10 + readSynchsafe(bytes, 6)));
		if (flags & 0x80) {
			tag = removeUnsync(tag);
		}
		let offset = 0;
		let unsyncedText = "";
		while (offset < tag.length) {
			let frameId;
			let frameSize;
			let headerSize;
			if (version === 2) {
				if (offset + 6 > tag.length) {
					break;
				}
				frameId = ascii(tag, offset, 3);
				frameSize = readUInt24BE(tag, offset + 3);
				headerSize = 6;
			} else {
				if (offset + 10 > tag.length) {
					break;
				}
				frameId = ascii(tag, offset, 4);
				frameSize = version === 4? readSynchsafe(tag, offset + 4): readUInt32BE(tag, offset + 4);
				headerSize = 10;
			}
			if (!frameId.replace(/\0/g, "") || !frameSize || frameSize < 0) {
				break;
			}
			const start = offset + headerSize;
			const end = Math.min(tag.length, start + frameSize);
			if (start >= end) {
				break;
			}
			const frame = tag.subarray(start, end);
			if ((frameId === "SYLT" || frameId === "SLT") && frame.length > 7) {
				const encodingByte = frame[0];
				const timeFormat = frame[4];
				const descriptor = readEncodedTerminated(frame, 6, encodingByte);
				let cursor = descriptor.next;
				const lines = [];
				const texts = [];
				while (cursor < frame.length) {
					const part = readEncodedTerminated(frame, cursor, encodingByte);
					cursor = part.next;
					if (cursor + 4 > frame.length) {
						break;
					}
					const stamp = readUInt32BE(frame, cursor);
					cursor += 4;
					if (part.text) {
						texts.push(part.text);
						if (timeFormat === 2) {
							lines.push({ time: stamp / 1000, text: part.text });
						}
					}
				}
				const normalized = normalizeLines(lines);
				if (normalized.length) {
					return { status: "synced", source: "embedded", lines: normalized };
				}
				if (texts.length) {
					unsyncedText = texts.join("\n");
				}
			}
			if ((frameId === "USLT" || frameId === "ULT") && frame.length > 4) {
				const encodingByte = frame[0];
				const descriptor = readEncodedTerminated(frame, 4, encodingByte);
				const info = getId3Encoding(encodingByte);
				const text = cleanText(decodeBytes(frame.subarray(descriptor.next), info.encoding));
				const lines = parseLrc(text);
				if (lines.length) {
					return { status: "synced", source: "embedded", lines };
				}
				if (text) {
					unsyncedText = text;
				}
			}
			if ((frameId === "TXXX" || frameId === "TXX") && frame.length > 2) {
				const encodingByte = frame[0];
				const description = readEncodedTerminated(frame, 1, encodingByte);
				const info = getId3Encoding(encodingByte);
				const value = cleanText(decodeBytes(frame.subarray(description.next), info.encoding));
				if (/lyric/i.test(description.text) || /\[\d{1,3}:\d{1,2}/.test(value)) {
					const lines = parseLrc(value);
					if (lines.length) {
						return { status: "synced", source: "embedded", lines };
					}
					if (value) {
						unsyncedText = value;
					}
				}
			}
			offset = end;
		}
		if (unsyncedText) {
			return { status: "unsynced", source: "embedded", text: unsyncedText };
		}
		return null;
	};

	const parseVorbisCommentBlock = bytes => {
		if (!bytes || bytes.length < 8) {
			return null;
		}
		let offset = 0;
		const vendorLength = readUInt32LE(bytes, offset);
		offset += 4 + vendorLength;
		if (offset + 4 > bytes.length) {
			return null;
		}
		const count = readUInt32LE(bytes, offset);
		offset += 4;
		let unsyncedText = "";
		for (let i = 0; i < count && offset + 4 <= bytes.length; i++) {
			const length = readUInt32LE(bytes, offset);
			offset += 4;
			if (length < 0 || offset + length > bytes.length) {
				break;
			}
			const entry = decodeBytes(bytes.subarray(offset, offset + length), "utf-8");
			offset += length;
			const split = entry.indexOf("=");
			if (split < 0) {
				continue;
			}
			const key = entry.slice(0, split).trim().toUpperCase();
			const value = cleanText(entry.slice(split + 1));
			if (!value || !["LYRICS", "UNSYNCEDLYRICS", "SYNCEDLYRICS", "LYRICS_SYNCED", "LYRIC"].includes(key)) {
				continue;
			}
			const lines = parseLrc(value);
			if (lines.length) {
				return { status: "synced", source: "embedded", lines };
			}
			unsyncedText = value;
		}
		return unsyncedText? { status: "unsynced", source: "embedded", text: unsyncedText }: null;
	};

	const parseFlac = bytes => {
		let start = -1;
		const searchEnd = Math.min(bytes.length - 4, 1024 * 1024);
		for (let i = 0; i <= searchEnd; i++) {
			if (ascii(bytes, i, 4) === "fLaC") {
				start = i + 4;
				break;
			}
		}
		if (start < 0) {
			return null;
		}
		let offset = start;
		while (offset + 4 <= bytes.length) {
			const header = bytes[offset];
			const last = !!(header & 0x80);
			const type = header & 0x7f;
			const length = readUInt24BE(bytes, offset + 1);
			const dataStart = offset + 4;
			const dataEnd = Math.min(bytes.length, dataStart + length);
			if (type === 4) {
				return parseVorbisCommentBlock(bytes.subarray(dataStart, dataEnd));
			}
			offset = dataEnd;
			if (last) {
				break;
			}
		}
		return null;
	};

	const parseOgg = bytes => {
		if (ascii(bytes, 0, 4) !== "OggS") {
			return null;
		}
		const packets = [];
		let packetParts = [];
		let packetLength = 0;
		let offset = 0;
		while (offset + 27 <= bytes.length && packets.length < 16) {
			if (ascii(bytes, offset, 4) !== "OggS") {
				break;
			}
			const segmentCount = bytes[offset + 26];
			const tableStart = offset + 27;
			const bodyStart = tableStart + segmentCount;
			if (bodyStart > bytes.length) {
				break;
			}
			let cursor = bodyStart;
			for (let i = 0; i < segmentCount; i++) {
				const length = bytes[tableStart + i];
				if (cursor + length > bytes.length) {
					return null;
				}
				packetParts.push(bytes.subarray(cursor, cursor + length));
				packetLength += length;
				cursor += length;
				if (length < 255) {
					const packet = new Uint8Array(packetLength);
					let write = 0;
					for (const part of packetParts) {
						packet.set(part, write);
						write += part.length;
					}
					packets.push(packet);
					packetParts = [];
					packetLength = 0;
				}
			}
			offset = cursor;
		}
		for (const packet of packets) {
			if (packet.length > 7 && packet[0] === 3 && ascii(packet, 1, 6) === "vorbis") {
				const result = parseVorbisCommentBlock(packet.subarray(7));
				if (result) {
					return result;
				}
			}
			if (packet.length > 8 && ascii(packet, 0, 8) === "OpusTags") {
				const result = parseVorbisCommentBlock(packet.subarray(8));
				if (result) {
					return result;
				}
			}
		}
		return null;
	};

	const parseM4a = bytes => {
		let unsyncedText = "";
		for (let i = 4; i + 4 < bytes.length; i++) {
			if (bytes[i] !== 0xa9 || ascii(bytes, i + 1, 3) !== "lyr") {
				continue;
			}
			const atomStart = i - 4;
			const atomSize = readUInt32BE(bytes, atomStart);
			if (atomSize < 16 || atomStart + atomSize > bytes.length) {
				continue;
			}
			const atomEnd = atomStart + atomSize;
			for (let j = i + 4; j + 16 <= atomEnd; j++) {
				if (ascii(bytes, j + 4, 4) !== "data") {
					continue;
				}
				const dataSize = readUInt32BE(bytes, j);
				const payloadStart = j + 16;
				const payloadEnd = Math.min(atomEnd, j + dataSize);
				if (payloadStart >= payloadEnd) {
					continue;
				}
				const text = cleanText(decodeBytes(bytes.subarray(payloadStart, payloadEnd), "utf-8"));
				const lines = parseLrc(text);
				if (lines.length) {
					return { status: "synced", source: "embedded", lines };
				}
				if (text) {
					unsyncedText = text;
				}
			}
		}
		return unsyncedText? { status: "unsynced", source: "embedded", text: unsyncedText }: null;
	};

	const parseWav = bytes => {
		if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
			return null;
		}
		let offset = 12;
		while (offset + 8 <= bytes.length) {
			const id = ascii(bytes, offset, 4).toLowerCase();
			const length = readUInt32LE(bytes, offset + 4);
			const start = offset + 8;
			const end = Math.min(bytes.length, start + length);
			if (id === "id3 " || id === "id3\0") {
				return parseId3(bytes.subarray(start, end));
			}
			offset = end + (length % 2);
		}
		return null;
	};

	const parseLyrics3 = bytes => {
		const startSearch = Math.max(0, bytes.length - 1024 * 1024);
		const tail = decodeBytes(bytes.subarray(startSearch), "windows-1252");
		const begin = tail.indexOf("LYRICSBEGIN");
		const end = tail.indexOf("LYRICSEND", begin + 11);
		if (begin < 0 || end < 0) {
			return null;
		}
		const text = cleanText(tail.slice(begin + 11, end));
		const lines = parseLrc(text);
		if (lines.length) {
			return { status: "synced", source: "embedded", lines };
		}
		return text? { status: "unsynced", source: "embedded", text }: null;
	};

	const parseEmbedded = async (file, data) => {
		const bytes = await toUint8Array(data);
		if (!bytes?.length) {
			return { status: "none", source: "none" };
		}
		const extension = String(file || "").split(".").pop().toLowerCase();
		let result = null;
		if (ascii(bytes, 0, 3) === "ID3") {
			result = parseId3(bytes);
		}
		if (!result && extension === "flac") {
			result = parseFlac(bytes);
		}
		if (!result && (extension === "ogg" || extension === "opus")) {
			result = parseOgg(bytes);
		}
		if (!result && (extension === "m4a" || extension === "mp4" || extension === "aac")) {
			result = parseM4a(bytes);
		}
		if (!result && extension === "wav") {
			result = parseWav(bytes);
		}
		if (!result && extension === "mp3") {
			result = parseLyrics3(bytes);
		}
		return result || { status: "none", source: "none" };
	};

	const tryReadExternalLrc = async ({ filePath, readFile }) => {
		if (!filePath || typeof readFile !== "function") {
			return null;
		}
		const base = String(filePath).replace(/\.[^.\\/]+$/, "");
		for (const path of [`${base}.lrc`, `${base}.LRC`]) {
			try {
				const data = await readFile(path);
				const bytes = await toUint8Array(data);
				if (!bytes?.length) {
					continue;
				}
				const text = decodeTextFile(bytes);
				const lines = parseLrc(text);
				if (lines.length) {
					return { status: "synced", source: "lrc", lines, path };
				}
				if (cleanText(text)) {
					return { status: "unsynced", source: "lrc", text: cleanText(text), path };
				}
			} catch (e) {}
		}
		return null;
	};

	const load = async options => {
		const file = String(options?.file || "");
		const filePath = String(options?.filePath || file);
		const cacheKey = filePath || file;
		if (cacheKey && cache.has(cacheKey)) {
			return cache.get(cacheKey);
		}
		let result = await tryReadExternalLrc({
			filePath,
			readFile: options?.readFile,
		});
		if (!result) {
			let audioData = options?.audioData;
			if (!audioData && typeof options?.readFile === "function" && filePath) {
				try {
					audioData = await options.readFile(filePath);
				} catch (e) {}
			}
			result = await parseEmbedded(file, audioData);
		}
		if (!result || result.status !== "synced" || !result.lines?.length) {
			result = result?.status === "unsynced"? result: { status: "none", source: "none" };
		}
		if (cacheKey) {
			cache.set(cacheKey, result);
		}
		return result;
	};

	const clearCache = filePath => {
		if (filePath) {
			cache.delete(String(filePath));
		} else {
			cache.clear();
		}
	};

	window.nncLyrics = {
		load,
		parseLrc,
		parseEmbedded,
		clearCache,
	};
})();
