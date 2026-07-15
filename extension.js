import { lib, game, ui, get, ai, _status } from "noname";

game.import("extension", () => {
	// 扩展里很多路径和配置键都要用到名称，统一放这里
	const EXT_NAME = "宁宁音乐盒";
	const MUSIC_DIR = `extension/${EXT_NAME}/music`;
	const SUPPORT_AUDIO = /\.(mp3|ogg|wav|m4a|flac)$/i;
	const SUPPORT_LRC = /\.lrc$/i;
	const PLAYBACK_RATES = ["0.5", "0.75", "1.0", "1.25", "1.5", "2.0"];
	// Blob播放时MIME要写对，不然放不了
	const AUDIO_MIME = {
		mp3: "audio/mpeg",
		ogg: "audio/ogg",
		wav: "audio/wav",
		m4a: "audio/mp4",
		flac: "audio/flac",
	};

	// modeMap管界面显示，modeOrder决定点“播放模式”时按什么顺序轮换
	const modeMap = {
		order: "顺序",
		listLoop: "循环",
		random: "随机",
		singleLoop: "单曲",
		favorite: "收藏",
	};
	const modeOrder = ["listLoop", "order", "random", "singleLoop", "favorite"];

	// 配置读取保持一个入口，这里顺带兼容以前的旧保存数据，别人用不用得上不知道，反正我用得上
	const getExtConfig = (key, defaultValue) => {
		const value = game.getExtensionConfig(EXT_NAME, key);
		return value === undefined ? defaultValue : value;
	};

	const saveExtConfig = (key, value) => game.saveExtensionConfig(EXT_NAME, key, value);
	const saveExtConfigAsync = (key, value) => game.promises.saveExtensionConfig(EXT_NAME, key, value);
	const plainText = (value) => get.plainText(String(value ?? ""));

	// 无名杀自己的 listen 会处理触屏差异，普通DOM节点直接走原生事件
	const bindClick = (node, handler) => {
		if (!node) {
			return;
		}
		const callback = (evt) => {
			evt.stopPropagation();
			handler(evt);
		};
		if (node.listen) {
			node.listen(callback);
		} else {
			node.addEventListener(lib.config.touchscreen ? "touchend" : "click", callback);
		}
	};

	// 这里只是为了少写几遍 createElement/appendChild，不打算把几个 div 包装成一套 UI 框架
	const createNode = (className, parent, text) => {
		const node = document.createElement("div");
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		if (parent) {
			parent.appendChild(node);
		}
		return node;
	};

	// music 目录不存在或读取失败时按空列表处理，播放器还能正常进游戏，防止进游戏就报错
	const getFileList = async (dir) => {
		try {
			return await game.promises.getFileList(dir);
		} catch (err) {
			console.warn(`${EXT_NAME}：读取音乐文件夹失败`, err);
			return [[], []];
		}
	};

	const createMusicBox = () => {
		const box = {
			// 播放器本体限这一份，状态直接放在单例上，查问题时方便从 game.nncMusicBox 看现场
			audio: null,
			list: [],
			index: 0,
			playing: false,

			// 切后台或页面重载造成的暂停不能覆盖原本的播放意图
			resumeWanted: false,
			gestureResumeInstalled: false,
			gestureResumeTrying: false,
			gestureResumeHandler: null,

			// 下面这组是悬浮窗自己的状态，和音频是否正在播放没有必然关系
			locked: false,
			panelClosed: false,
			hideTimer: null,
			inited: false,
			nodes: {},

			// 本体 BGM 和音乐盒各有自己的生命周期，必须记住到底是谁把谁暂停了
			pausedBackgroundMusic: false,
			bgmGuardTimer: null,
			bgmGuardInstalled: false,
			pausedByVisibility: false,
			pageLifecycleInstalled: false,

			// 各类定时器和交互标记集中放着，省的找起来麻烦
			progressTimer: null,
			seeking: false,
			seekDragValue: null,
			dragging: false,
			fadeTimer: null,
			uiGuardTimer: null,
			failedFiles: new Set(),
			playbackSaveTimer: null,
			reloadHookInstalled: false,
			reloadSaving: false,
			restoringPlayback: false,
			lastPlaybackStateKey: "",
			lyricsData: null,
			lyricsFile: "",
			lyricsIndex: -1,
			lyricsLoadToken: 0,
			lyricsLoadingToken: 0,
			lyricsNoticeTimer: null,
			lyricsNoticeUntil: 0,
			lyricsNoticeText: "",
			titleMarqueeFrame: null,
			titleResizeObserver: null,
			panelPositionSaveTask: null,

			// 配置 getter 直接反映当前设置，扩展菜单改完不重建整个对象
			get showPanel() {
				return getExtConfig("showPanel", true);
			},
			get autoHideTime() {
				return getExtConfig("autoHideTime", "5");
			},
			get mode() {
				return getExtConfig("playMode", "listLoop");
			},
			set mode(value) {
				saveExtConfig("playMode", value);
			},
			get resumePolicy() {
				const value = getExtConfig("resumePolicy", "all");
				return ["all", "reload", "off"].includes(value) ? value : "all";
			},

			get rememberSong() {
				return this.resumePolicy !== "off";
			},
			get rememberProgress() {
				return getExtConfig("rememberProgress", true);
			},
			get showLyrics() {
				return getExtConfig("showLyrics", true);
			},
			get playbackRate() {
				const value = Number(getExtConfig("playbackRate", "1.0"));
				return PLAYBACK_RATES.some((rate) => Number(rate) === value) ? value : 1;
			},
			set playbackRate(value) {
				const rate = PLAYBACK_RATES.find((item) => Number(item) === Number(value)) || "1.0";
				saveExtConfig("playbackRate", rate);
				this.updatePlaybackRate();
			},
			get boxVolume() {
				const value = Number(getExtConfig("boxVolume", 100));
				if (!Number.isFinite(value)) {
					return 100;
				}
				return Math.max(0, Math.min(100, value));
			},
			get favorites() {
				const list = getExtConfig("favorites", []);
				return Array.isArray(list) ? list : [];
			},
			get displayNames() {
				const map = getExtConfig("displayNames", {});
				if (!map || typeof map != "object" || Array.isArray(map)) {
					return {};
				}
				return map;
			},
			set displayNames(map) {
				saveExtConfig("displayNames", map);
			},
			set boxVolume(value) {
				value = Number(value);
				if (!Number.isFinite(value)) {
					value = 100;
				}
				value = Math.max(0, Math.min(100, value));
				saveExtConfig("boxVolume", value);
				this.updateVolume();
			},
			set favorites(list) {
				saveExtConfig("favorites", list);
			},

			// 收藏用下磁盘文件名做键，不受歌曲重命名影响
			isFavorite(file) {
				return this.favorites.includes(file);
			},

			toggleFavorite(file, heartNode) {
				if (!file) {
					return;
				}
				const list = this.favorites.slice();
				const added = !list.includes(file);
				if (added) {
					list.push(file);
				} else {
					list.remove(file);
				}
				this.favorites = list;
				if (!heartNode) {
					this.refreshListPanel();
					return;
				}
				heartNode.textContent = added ? "♥" : "♡";
				heartNode.classList.toggle("active", added);
				this.playFavoriteEffect(heartNode, added);
			},

			// 收藏动画定位是这里最绕的地方，感觉会被某些美化扩展影响，哎，影响就影响，和我无关，反正我又不会用某些扩展而受这影响
			playFavoriteEffect(heartNode, added) {
				const panel = this.nodes.listPanel;
				if (!panel || !heartNode) {
					return;
				}
				const heartRect = heartNode.getBoundingClientRect();
				const panelRect = panel.getBoundingClientRect();

				//可能被上层UI缩放，所以屏幕坐标需要换算回面板内部坐标
				const scaleX = panel.offsetWidth > 0 ? panelRect.width / panel.offsetWidth : 1;
				const scaleY = panel.offsetHeight > 0 ? panelRect.height / panel.offsetHeight : 1;
				const centerX = (heartRect.left + heartRect.width / 2 - panelRect.left) / scaleX;
				const centerY = (heartRect.top + heartRect.height / 2 - panelRect.top) / scaleY;
				heartNode.classList.remove("nnc-heart-pop", "nnc-heart-cancel");
				heartNode.offsetHeight;
				heartNode.classList.add(added ? "nnc-heart-pop" : "nnc-heart-cancel");
				const effect = createNode(`nnc-favorite-effect ${added ? "add" : "remove"}`, panel);
				effect.style.left = `${centerX}px`;
				effect.style.top = `${centerY}px`;

				if (added) {
					const particles = [
						[-22, -34, 0.58, 0],
						[-10, -46, 0.72, 35],
						[3, -38, 0.52, 70],
						[16, -48, 0.68, 20],
						[25, -30, 0.48, 85],
					];
					for (const [x, y, scale, delay] of particles) {
						const particle = createNode("nnc-favorite-particle", effect, "♥");
						particle.style.setProperty("--x", `${x}px`);
						particle.style.setProperty("--y", `${y}px`);
						particle.style.setProperty("--scale", scale);
						particle.style.setProperty("--delay", `${delay}ms`);
					}
				} else {
					createNode("nnc-favorite-break-half left", effect, "♥");
					createNode("nnc-favorite-break-half right", effect, "♥");
				}

				setTimeout(() => {
					effect.remove();
					heartNode.classList.remove("nnc-heart-pop", "nnc-heart-cancel");
				}, 700);
			},

			getOriginalDisplayName(file) {
				return String(file || "").replace(/\.[^.]+$/, "");
			},

			getDisplayName(file) {
				const savedName = this.displayNames[file];
				if (typeof savedName == "string" && savedName.trim()) {
					return savedName.trim();
				}
				return this.getOriginalDisplayName(file);
			},

			//给歌曲添加一个自定义昵称，不改磁盘文件名
			renameDisplayName(item) {
				if (!item?.file) {
					return;
				}
				const originalName = this.getOriginalDisplayName(item.file);
				const result = window.prompt(`输入要变更的新名称。`, item.name);
				if (result === null) {
					return;
				}
				const name = plainText(result).replace(/\s+/g, " ").trim().slice(0, 80);
				const map = {
					...this.displayNames,
				};
				if (!name || name == originalName) {
					delete map[item.file];
				} else {
					map[item.file] = name;
				}
				this.displayNames = map;
				item.originalName = originalName;
				item.name = this.getDisplayName(item.file);
				this.refreshPanel();
				this.toast(name ? `已成功重命名为《${item.name}》` : `本次重命名无变化`);
			},

			// 初始化先跑一次，先扫歌，再让续播和 UI 初始化并行，能少等一点是一点
			async init() {
				if (this.inited) {
					return;
				}
				this.inited = true;
				await this.scan();
				const savedIndex = getExtConfig("lastIndex", 0);
				if (Number.isFinite(Number(savedIndex))) {
					this.index = Math.max(0, Math.min(this.list.length - 1, Number(savedIndex)));
				}
				this.ensureAudio();
				this.updateVolume();

				// 先开始读取续播歌曲，再让音乐恢复和后面的UI初始化同时进行，不过体感下来感觉恢复续播的速度好像没快多少
				const restoreTask = this.restorePlaybackState();
				this.installProgressSync();
				this.installPageLifecycleGuard();
				this.installPlaybackStateGuard();
				this.installGameUIVisibilityGuard();
				if (this.showPanel) {
					this.createPanel();
					this.refreshPanel();
					if (getExtConfig("startMini", true)) {
						this.minimizePanel();
					} else {
						this.resetHideTimer();
					}
				}
				await restoreTask;
			},

			// 每次扫描都重建列表项，Blob URL 则按本次运行重新生成，不往配置里塞这种临时地址
			async scan() {
				const [, files] = await getFileList(MUSIC_DIR);
				this.list = files
					.filter((file) => SUPPORT_AUDIO.test(file))
					.sort((a, b) => a.localeCompare(b))
					.map((file) => {
						const originalName = this.getOriginalDisplayName(file);
						return {
							file,
							originalName,
							name: this.getDisplayName(file),
							path: `${lib.assetURL}${MUSIC_DIR}/${file}`,
							filePath: `${MUSIC_DIR}/${file}`,
							blobUrl: null,
						};
					});
				if (this.index >= this.list.length) {
					this.index = 0;
				}
				this.refreshPanel();
				return this.list;
			},

			// 续播只保存当前这一首的进度记录
			getPlaybackState(resumeOverride, restoreReason = "normal") {
				if (!this.rememberSong || !this.audio || !this.audio.src) {
					return null;
				}
				const current = this.getCurrent();
				if (!current) {
					return null;
				}
				let currentTime = this.rememberProgress ? Number(this.audio.currentTime) : 0;
				if (!Number.isFinite(currentTime) || currentTime < 0) {
					currentTime = 0;
				}

				const resumeWanted =
					typeof resumeOverride == "boolean"
						? resumeOverride
						: this.resumeWanted || this.playing || this.isMusicBoxActuallyPlaying();

				return {
					file: current.file,
					currentTime,
					resumeWanted,
					restoreReason,
				};
			},

			// 普通播放期间按“歌曲 + 整秒进度 + 状态”去重，避免五秒轮询每次都重复写同一份配置
			async savePlaybackState(playingOverride, force = false, waitForWrite = false, restoreReason = "normal") {
				if (this.restoringPlayback) {
					return;
				}
				const state = this.getPlaybackState(playingOverride, restoreReason);
				if (!state) {
					return;
				}
				const stateKey = [
					state.file,
					Math.floor(state.currentTime),
					state.resumeWanted ? 1 : 0,
					state.restoreReason,
				].join("|");
				if (!force && stateKey == this.lastPlaybackStateKey) {
					return;
				}
				this.lastPlaybackStateKey = stateKey;
				if (waitForWrite) {
					await saveExtConfigAsync("playbackState", state);
				} else {
					saveExtConfig("playbackState", state);
				}
			},

			//当“停止”被点就视为明确放弃续播，防止下次启动恢复续播
			clearPlaybackState() {
				this.resumeWanted = false;
				this.removeGestureResume();
				this.lastPlaybackStateKey = "";
				saveExtConfig("playbackState", null);
			},

			// 有些音频的 metadata 事件来得很慢，毕竟等太久也没意义，四秒后继续走兜底流程
			waitForAudioMetadata(audio, timeout = 4000) {
				if (audio.readyState >= 1) {
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					let finished = false;
					const finish = () => {
						if (finished) {
							return;
						}
						finished = true;
						audio.removeEventListener("loadedmetadata", finish);
						audio.removeEventListener("durationchange", finish);
						clearTimeout(timer);
						resolve();
					};
					const timer = setTimeout(finish, timeout);
					audio.addEventListener("loadedmetadata", finish);
					audio.addEventListener("durationchange", finish);
				});
			},

			// 恢复顺序不能乱：先装载音频、等时长、再写 currentTime，反过来在部分 WebView 里会被吃掉
			async restorePlaybackState() {
				if (!this.rememberSong) {
					return false;
				}
				const state = getExtConfig("playbackState", null);
				if (!state || typeof state != "object" || !state.file) {
					return false;
				}

				// “仅重启”不会被普通退出时写入的记录触发
				if (this.resumePolicy === "reload" && state.restoreReason !== "reload") {
					return false;
				}
				const resumeWanted = state.resumeWanted === true;
				this.resumeWanted = resumeWanted;
				const index = this.getListIndexByFile(state.file);
				if (index < 0) {
					this.clearPlaybackState();
					return false;
				}
				this.restoringPlayback = true;
				this.index = index;
				const item = this.getCurrent();
				const audio = this.ensureAudio();
				this.resetLyricsForItem(item);
				try {
					audio.src = await this.resolveAudioUrl(item);
					audio.volume = this.getFinalVolume();
					audio.load();
					await this.waitForAudioMetadata(audio);
					let currentTime = this.rememberProgress ? Number(state.currentTime) : 0;
					if (!Number.isFinite(currentTime) || currentTime < 0) {
						currentTime = 0;
					}
					const duration = Number(audio.duration);
					if (Number.isFinite(duration) && duration > 0) {
						currentTime = Math.min(currentTime, Math.max(0, duration - 0.25));
					}
					if (currentTime > 0) {
						audio.currentTime = currentTime;
					}
					this.updateProgress();
					this.refreshPanel();
					// resume里还要写回播放状态，先撤掉恢复标记，不然会被拦掉
					this.restoringPlayback = false;
					if (resumeWanted) {
						const success = await this.resume(false, false);
						if (!success) {
							this.refreshPanel("点击任意位置继续播放");
							this.installGestureResume();
						}
					}
					return true;
				} catch (err) {
					console.warn(`${EXT_NAME}：恢复上次播放状态失败`, err);
					this.refreshPanel("恢复播放失败");
					return false;
				} finally {
					this.restoringPlayback = false;
				}
			},

			//当自动播放被系统拦下时，下一次真实点击再试一下，反正一般不管玩什么模式都要点一下屏幕去选对应模式
			installGestureResume() {
				if (this.gestureResumeInstalled || !this.resumeWanted || this.isMusicBoxActuallyPlaying()) {
					return;
				}
				this.gestureResumeInstalled = true;
				const handler = () => {
					if (!this.resumeWanted || this.isMusicBoxActuallyPlaying()) {
						this.removeGestureResume();
						return;
					}
					if (this.gestureResumeTrying) {
						return;
					}
					this.gestureResumeTrying = true;
					this.resume(false, false)
						.then((success) => {
							this.gestureResumeTrying = false;
							if (success) {
								this.removeGestureResume();
							}
						})
						.catch(() => {
							this.gestureResumeTrying = false;
						});
				};
				this.gestureResumeHandler = handler;
				document.addEventListener("pointerdown", handler, true);
				document.addEventListener("touchend", handler, true);
				document.addEventListener("click", handler, true);
			},

			removeGestureResume() {
				const handler = this.gestureResumeHandler;
				if (handler) {
					document.removeEventListener("pointerdown", handler, true);
					document.removeEventListener("touchend", handler, true);
					document.removeEventListener("click", handler, true);
				}
				this.gestureResumeHandler = null;
				this.gestureResumeInstalled = false;
				this.gestureResumeTrying = false;
			},

			//额外保险
			installPlaybackStateGuard() {
				clearInterval(this.playbackSaveTimer);
				this.playbackSaveTimer = setInterval(() => {
					if (this.playing || this.isMusicBoxActuallyPlaying()) {
						this.savePlaybackState(true);
					}
				}, 5000);
				window.addEventListener("beforeunload", () => {
					this.saveCurrentPanelPosition();
					this.savePlaybackState(undefined, true, false, this.reloadSaving ? "reload" : "exit");
				});
				this.installReloadHook();
			},

			// game.reload一调用页面就要走了，最多等几十毫秒，不能为了存档把重启卡在那里，也不知道会不会受某些扩展影响
			installReloadHook() {
				if (this.reloadHookInstalled || typeof game.reload != "function") {
					return;
				}
				this.reloadHookInstalled = true;
				const originalReload = game.reload.bind(game);
				game.reload = (...args) => {
					if (this.reloadSaving) {
						return;
					}
					this.reloadSaving = true;
					const playbackTask = this.savePlaybackState(undefined, true, true, "reload");
					const positionTask = this.saveCurrentPanelPosition();
					const saveTask = Promise.allSettled([playbackTask, positionTask]);
					const timeout = new Promise((resolve) => setTimeout(resolve, 80));
					Promise.race([saveTask, timeout]).finally(() => {
						originalReload(...args);
					});
				};
			},

			// 文件后缀已经在扫描阶段过滤过，这里给Blob一个靠谱的类型就够了
			getAudioMime(file) {
				const ext = String(file).split(".").pop().toLowerCase();
				return AUDIO_MIME[ext] || "audio/mpeg";
			},

			// 导入文件名只做必要清理，显示名称为另一套逻辑
			getSafeFileName(name) {
				const safeName = String(name || "music.mp3")
					.replace(/[\\/:*?"<>|]/g, "_")
					.replace(/\s+/g, " ")
					.trim();
				return safeName || `music_${Date.now()}.mp3`;
			},

			// 同名文件不覆盖，宁可多一个_1，这个问题可能是要考虑一下怎么解决，不过先放着吧
			getUniqueFileName(name, existing) {
				name = this.getSafeFileName(name);
				if (!existing.has(name)) {
					return name;
				}
				const dot = name.lastIndexOf(".");
				const base = dot >= 0 ? name.slice(0, dot) : name;
				const ext = dot >= 0 ? name.slice(dot) : "";
				let index = 1;
				let result = `${base}_${index}${ext}`;
				while (existing.has(result)) {
					index++;
					result = `${base}_${index}${ext}`;
				}
				return result;
			},

			// 部分旧 WebView 没有 File.arrayBuffer，这一段能用就用
			readImportFile(file) {
				if (file.arrayBuffer) {
					return file.arrayBuffer();
				}
				return new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = (evt) => {
						resolve(evt.target.result);
					};
					reader.onerror = (err) => {
						reject(err);
					};
					reader.readAsArrayBuffer(file);
				});
			},

			async writeMusicFile(file, targetName) {
				const data = await this.readImportFile(file);
				try {
					await game.promises.writeFile(data, MUSIC_DIR, targetName);
				} catch {
					// 少数移动端只接受 File/Blob，ArrayBuffer 写入失败后再试一次原文件
					await game.promises.writeFile(file, MUSIC_DIR, targetName);
				}
				return targetName;
			},

			// 音频和同名lrc可以一批选中，遇到重名时两边共用同一个新基础名，免得导入完后歌词失联
			async importMusicFiles() {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = "audio/*,.mp3,.ogg,.wav,.m4a,.flac,.lrc,text/plain";
				input.multiple = true;
				const files = await new Promise((resolve) => {
					input.onchange = () => {
						resolve(Array.from(input.files || []));
					};
					input.click();
				});
				const importFiles = files.filter((file) => {
					return SUPPORT_AUDIO.test(file.name) || SUPPORT_LRC.test(file.name);
				});
				const musicFiles = importFiles.filter((file) => SUPPORT_AUDIO.test(file.name));
				const lyricFiles = importFiles.filter((file) => SUPPORT_LRC.test(file.name));
				if (!importFiles.length) {
					alert("没有选择可导入的音乐或 LRC 歌词文件");
					return;
				}

				const confirmText = [
					"确定要导入以下文件到宁宁音乐盒的 music 文件夹吗？",
					`音乐：${musicFiles.length} 个`,
					`歌词：${lyricFiles.length} 个`,
				].join("\n");
				if (!confirm(confirmText)) {
					return;
				}
				const [, currentFiles] = await getFileList(MUSIC_DIR);
				const existing = new Set(currentFiles || []);
				const successMusic = [];
				const successLyrics = [];
				const failed = [];
				const getBaseName = (name) => {
					const dot = name.lastIndexOf(".");
					return dot >= 0 ? name.slice(0, dot) : name;
				};
				const getPairKey = (name) => {
					return getBaseName(this.getSafeFileName(name)).toLocaleLowerCase();
				};
				const pendingLyrics = new Map();
				for (const file of lyricFiles) {
					const key = getPairKey(file.name);
					pendingLyrics.set(key, (pendingLyrics.get(key) || 0) + 1);
				}

				// 同一批次内有同名歌词时，同时为音频和歌词寻找可用的共同基础名
				const getPairedTarget = (safeAudioName, needsLyric) => {
					const dot = safeAudioName.lastIndexOf(".");
					const base = dot >= 0 ? safeAudioName.slice(0, dot) : safeAudioName;
					const ext = dot >= 0 ? safeAudioName.slice(dot) : "";
					let index = 0;

					while (true) {
						const targetBase = index ? `${base}_${index}` : base;
						const audioName = `${targetBase}${ext}`;
						const lyricName = `${targetBase}.lrc`;
						if (!existing.has(audioName) && (!needsLyric || !existing.has(lyricName))) {
							return { audioName, lyricName };
						}
						index++;
					}
				};

				const pairedLyricTargets = new Map();

				for (const file of musicFiles) {
					const safeName = this.getSafeFileName(file.name);
					const pairKey = getPairKey(file.name);
					const needsLyric = (pendingLyrics.get(pairKey) || 0) > 0;
					const target = getPairedTarget(safeName, needsLyric);
					try {
						await this.writeMusicFile(file, target.audioName);
						existing.add(target.audioName);
						successMusic.push(target.audioName);
						if (needsLyric) {
							existing.add(target.lyricName);
							if (!pairedLyricTargets.has(pairKey)) {
								pairedLyricTargets.set(pairKey, []);
							}
							pairedLyricTargets.get(pairKey).push(target.lyricName);
							pendingLyrics.set(pairKey, pendingLyrics.get(pairKey) - 1);
						}
					} catch (err) {
						console.warn(`${EXT_NAME}：导入音乐失败`, file.name, err);
						failed.push(file.name);
					}
				}

				for (const file of lyricFiles) {
					const pairKey = getPairKey(file.name);
					const pairQueue = pairedLyricTargets.get(pairKey);
					let targetName;
					if (pairQueue?.length) {
						targetName = pairQueue.shift();
					} else {
						const safeName = this.getSafeFileName(file.name);
						targetName = this.getUniqueFileName(safeName, existing);
						existing.add(targetName);
					}
					try {
						await this.writeMusicFile(file, targetName);
						successLyrics.push(targetName);
					} catch (err) {
						console.warn(`${EXT_NAME}：导入歌词失败`, file.name, err);
						failed.push(file.name);
					}
				}

				await this.scan();
				window.nncLyrics?.clearCache();

				const current = this.getCurrent();
				if (this.showLyrics && current && this.audio?.src) {
					this.resetLyricsForItem(current);
					this.loadLyricsForItem(current);
				}
				this.refreshPanel();

				let message = [
					"导入完成。",
					`音乐成功：${successMusic.length} 个`,
					`歌词成功：${successLyrics.length} 个`,
					`失败：${failed.length} 个`,
				].join("\n");
				if (failed.length) {
					message += `\n\n失败文件：\n${failed.slice(0, 5).join("\n")}`;
					if (failed.length > 5) {
						message += "\n……";
					}
				}
				message += "\n\n如果新导入的音乐或歌词未立即生效，建议重启游戏刷新资源。";
				if (confirm(`${message}\n\n是否立即重启游戏？`)) {
					if (game.reload) {
						game.reload();
					} else {
						location.reload();
					}
				}
			},

			// 音频播放和歌词解析走同一个读取入口，至少出问题时不用排查两套路径
			readFileData(filePath) {
				return game.promises.readFile(filePath);
			},

			// 清界面和清解析结果分开控制，避免关闭“显示歌词”时把所有状态拆得七零八落
			clearLyricsDisplay(resetData = true) {
				clearTimeout(this.lyricsNoticeTimer);
				this.lyricsNoticeTimer = null;
				this.lyricsNoticeUntil = 0;
				this.lyricsNoticeText = "";
				if (resetData) {
					this.lyricsData = null;
					this.lyricsIndex = -1;
				}
				if (this.nodes.lyric) {
					this.nodes.lyric.textContent = "";
				}
				if (this.nodes.panel) {
					this.nodes.panel.classList.remove("has-current-lyrics", "lyrics-notice");
				}
			},

			// token每切一首就加一，上一首晚到的解析结果看到号码不对会作废，虽然一般情况下应该不会出现这种问题
			resetLyricsForItem(item) {
				this.lyricsLoadToken++;
				this.lyricsLoadingToken = 0;
				this.lyricsFile = item?.file || "";
				this.clearLyricsDisplay(true);
			},

			renderLyricsState(force = false) {
				if (!this.nodes.panel || !this.nodes.lyric) {
					return;
				}
				if (!this.showLyrics) {
					this.clearLyricsDisplay(false);
					return;
				}
				if (this.lyricsNoticeUntil && this.lyricsNoticeUntil > Date.now()) {
					this.nodes.lyric.textContent = this.lyricsNoticeText;
					this.nodes.panel.classList.remove("has-current-lyrics");
					this.nodes.panel.classList.add("lyrics-notice");
					return;
				}
				this.nodes.panel.classList.remove("lyrics-notice");
				if (this.lyricsData?.lines?.length) {
					this.updateLyrics(force);
					return;
				}
				this.nodes.lyric.textContent = "";
				this.nodes.panel.classList.remove("has-current-lyrics");
			},

			// 没有同步歌词只提示三秒然后关闭提示
			showNoLyricsNotice(token) {
				if (token !== this.lyricsLoadToken) {
					return;
				}
				clearTimeout(this.lyricsNoticeTimer);
				this.lyricsData = null;
				this.lyricsIndex = -1;
				this.lyricsNoticeText = "无歌词显示，3秒后将关闭该提示";
				this.lyricsNoticeUntil = Date.now() + 3000;
				this.renderLyricsState(true);
				this.lyricsNoticeTimer = setTimeout(() => {
					if (token !== this.lyricsLoadToken) {
						return;
					}
					this.lyricsNoticeUntil = 0;
					this.lyricsNoticeText = "";
					this.renderLyricsState(true);
				}, 3000);
			},

			// 播放不等歌词，解析慢一点没关系，先响再说，结果回来后再补到界面上
			async loadLyricsForItem(item, audioData) {
				if (!item?.file) {
					return;
				}
				if (!this.showLyrics) {
					this.clearLyricsDisplay(true);
					return;
				}
				if (this.lyricsFile !== item.file) {
					this.resetLyricsForItem(item);
				}
				const token = this.lyricsLoadToken;
				if (this.lyricsLoadingToken === token) {
					return;
				}
				this.lyricsLoadingToken = token;
				try {
					const helper = window.nncLyrics || (await window.nncLyricsReady);
					if (token !== this.lyricsLoadToken || this.lyricsFile !== item.file) {
						return;
					}
					if (!helper?.load) {
						this.showNoLyricsNotice(token);
						return;
					}
					const result = await helper.load({
						file: item.file,
						filePath: item.filePath,
						audioData,
						readFile: (filePath) => this.readFileData(filePath),
					});
					if (token !== this.lyricsLoadToken || this.lyricsFile !== item.file) {
						return;
					}
					if (result?.status === "synced" && Array.isArray(result.lines) && result.lines.length) {
						clearTimeout(this.lyricsNoticeTimer);
						this.lyricsNoticeTimer = null;
						this.lyricsNoticeUntil = 0;
						this.lyricsNoticeText = "";
						this.lyricsData = result;
						this.lyricsIndex = -1;
						this.renderLyricsState(true);
						return;
					}
					this.showNoLyricsNotice(token);
				} catch (err) {
					console.warn(`${EXT_NAME}：读取歌词失败`, item.file, err);
					this.showNoLyricsNotice(token);
				}
			},

			// 歌词行数多时用二分找当前句，避免每次从头开始找
			updateLyrics(force = false) {
				if (
					!this.showLyrics ||
					!this.audio ||
					!this.nodes.panel ||
					!this.nodes.lyric ||
					!this.lyricsData?.lines?.length
				) {
					return;
				}
				const currentTime = Number(this.audio.currentTime);
				if (!Number.isFinite(currentTime)) {
					return;
				}
				const lines = this.lyricsData.lines;
				let left = 0;
				let right = lines.length - 1;
				let index = -1;

				while (left <= right) {
					const middle = Math.floor((left + right) / 2);
					if (lines[middle].time <= currentTime) {
						index = middle;
						left = middle + 1;
					} else {
						right = middle - 1;
					}
				}
				if (!force && index === this.lyricsIndex) {
					return;
				}
				this.lyricsIndex = index;
				this.nodes.panel.classList.remove("lyrics-notice");
				if (index < 0) {
					this.nodes.lyric.textContent = "";
					this.nodes.panel.classList.remove("has-current-lyrics");
					return;
				}
				const text = plainText(lines[index].text);
				if (!text) {
					this.nodes.lyric.textContent = "";
					this.nodes.panel.classList.remove("has-current-lyrics");
					return;
				}
				this.nodes.lyric.textContent = text;
				this.nodes.panel.classList.add("has-current-lyrics");
			},

			// 移动端直接播放扩展路径时拖动进度不稳定，因此优先使用 Blob URL
			async resolveAudioUrl(item) {
				if (!item) {
					return "";
				}
				if (item.blobUrl) {
					if (this.showLyrics) {
						this.loadLyricsForItem(item);
					}
					return item.blobUrl;
				}
				const filePath = item.filePath || `${MUSIC_DIR}/${item.file}`;
				try {
					const data = await this.readFileData(filePath);
					if (data) {
						if (this.showLyrics) {
							this.loadLyricsForItem(item, data);
						}
						const blob =
							data instanceof Blob
								? data
								: new Blob([data], {
										type: this.getAudioMime(item.file),
									});
						item.blobUrl = URL.createObjectURL(blob);
						return item.blobUrl;
					}
				} catch (err) {
					console.warn(`${EXT_NAME}：读取音频文件失败，回退到普通路径`, item.file, err);
				}
				if (this.showLyrics) {
					this.loadLyricsForItem(item);
				}
				return item.path;
			},

			// audio元素懒创建并常驻，切歌只换 src，避免每首歌都重新绑一遍事件
			ensureAudio() {
				if (this.audio) {
					return this.audio;
				}
				const audio = document.createElement("audio");
				audio.preload = "auto";
				audio.nncMusicBox = true;
				audio.volume = this.getFinalVolume();
				audio.playbackRate = this.playbackRate;
				if ("preservesPitch" in audio) {
					audio.preservesPitch = true;
				}
				if ("webkitPreservesPitch" in audio) {
					audio.webkitPreservesPitch = true;
				}
				audio.style.display = "none";
				audio.addEventListener("ended", () => {
					this.onEnded();
				});
				audio.addEventListener("play", () => {
					this.playing = true;
					this.pauseBackgroundMusic();
					this.startBackgroundMusicGuard();
					this.refreshPanel();
				});
				audio.addEventListener("pause", () => {
					this.playing = false;
					this.refreshPanel();
				});
				audio.addEventListener("error", () => {
					this.skipFailedCurrent();
				});
				audio.addEventListener("loadedmetadata", () => {
					this.updatePlaybackRate();
					this.updateProgress();
				});
				audio.addEventListener("durationchange", () => {
					this.updateProgress();
				});
				audio.addEventListener("timeupdate", () => {
					this.updateProgress();
				});
				this.audio = audio;
				(ui.window || document.body).appendChild(audio);
				return audio;
			},
			// 同一首失败一次时存下，后续会直接跳过
			skipFailedCurrent() {
				const current = this.getCurrent();
				if (!current || this.failedFiles.has(current.file)) {
					return;
				}
				this.failedFiles.add(current.file);
				this.toast(`歌曲《${current.name}》播放失败，已跳过`);
				this.next(true);
			},
			getFinalVolume() {
				return this.boxVolume / 100;
			},
			updateVolume() {
				if (this.audio) {
					this.audio.volume = this.getFinalVolume();
				}
				if (this.nodes.volumeSlider) {
					this.nodes.volumeSlider.value = this.boxVolume;
				}
				if (this.nodes.volumeValue) {
					this.nodes.volumeValue.textContent = `${this.boxVolume}%`;
				}
			},

			// 倍速切换后保留音调，避免变调
			updatePlaybackRate() {
				if (!this.audio) {
					return;
				}
				this.audio.playbackRate = this.playbackRate;
				if ("preservesPitch" in this.audio) {
					this.audio.preservesPitch = true;
				}
				if ("webkitPreservesPitch" in this.audio) {
					this.audio.webkitPreservesPitch = true;
				}
			},
			// 淡入淡出，增加体验感，意义不大，随手写了一下
			fadeToVolume(target, duration = 300) {
				return new Promise((resolve) => {
					if (!this.audio) {
						resolve();
						return;
					}
					clearInterval(this.fadeTimer);
					target = Math.max(0, Math.min(1, target));
					const audio = this.audio;
					const start = Number(audio.volume) || 0;
					const startTime = Date.now();
					this.fadeTimer = setInterval(() => {
						const rate = Math.min(1, (Date.now() - startTime) / duration);
						audio.volume = start + (target - start) * rate;
						if (rate >= 1) {
							clearInterval(this.fadeTimer);
							this.fadeTimer = null;
							audio.volume = target;
							resolve();
						}
					}, 30);
				});
			},

			formatTime(time) {
				time = Number(time);
				if (!Number.isFinite(time) || time < 0) {
					time = 0;
				}
				const minute = Math.floor(time / 60);
				const second = Math.floor(time % 60);
				return `${minute}:${second < 10 ? "0" : ""}${second}`;
			},

			// 拖动进度时，定时刷新先停止，不然滑块会蹦迪
			updateProgress() {
				if (!this.audio || !this.nodes.progressSlider) {
					return;
				}
				if (this.seeking) {
					return;
				}
				const duration = Number(this.audio.duration);
				const current = Number(this.audio.currentTime);
				if (!Number.isFinite(duration) || duration <= 0) {
					this.nodes.progressSlider.value = 0;
					this.nodes.currentTime.textContent = "0:00";
					this.nodes.durationTime.textContent = "0:00";
					return;
				}
				const value = Math.round(Math.max(0, Math.min(1, current / duration)) * 1000);
				this.nodes.progressSlider.value = value;
				this.nodes.currentTime.textContent = this.formatTime(current);
				this.nodes.durationTime.textContent = this.formatTime(duration);
				this.updateLyrics();
			},

			installProgressSync() {
				clearInterval(this.progressTimer);
				this.progressTimer = setInterval(() => {
					this.updateProgress();
				}, 500);
			},

			previewProgress(value) {
				if (!this.audio || !this.nodes.currentTime) {
					return;
				}
				const duration = Number(this.audio.duration);
				if (!Number.isFinite(duration) || duration <= 0) {
					return;
				}
				value = Number(value);
				if (!Number.isFinite(value)) {
					return;
				}
				const current = (duration * Math.max(0, Math.min(1000, value))) / 1000;
				this.nodes.currentTime.textContent = this.formatTime(current);
			},

			// 进度条统一用 0~1000，清晰并且避免直接把浮点秒数绑到 input 上
			seekProgress(value) {
				if (!this.audio) {
					return;
				}
				const audio = this.audio;
				const duration = Number(audio.duration);
				if (!Number.isFinite(duration) || duration <= 0) {
					this.toast("歌曲信息尚未加载完成，暂时无法跳转进度");
					return;
				}
				value = Number(value);
				if (!Number.isFinite(value)) {
					return;
				}

				const target = (duration * Math.max(0, Math.min(1000, value))) / 1000;
				const wasPlaying = this.playing || this.isMusicBoxActuallyPlaying();

				try {
					audio.currentTime = target;

					// 部分移动端 WebView 会吞掉第一次 seek，短暂延迟后补写两次
					for (const delay of [120, 360]) {
						setTimeout(() => {
							try {
								if (Math.abs(audio.currentTime - target) > 1.2) {
									audio.currentTime = target;
								}
							} catch {}
						}, delay);
					}
					if (wasPlaying && audio.paused) {
						Promise.resolve(audio.play()).catch((err) => {
							console.warn(`${EXT_NAME}：进度跳转后继续播放失败`, err);
						});
					}
					this.nodes.progressSlider.value = Math.round(Math.max(0, Math.min(1, target / duration)) * 1000);
					this.nodes.currentTime.textContent = this.formatTime(target);
					this.nodes.durationTime.textContent = this.formatTime(duration);
					this.savePlaybackState(wasPlaying, true);
				} catch (err) {
					console.warn(`${EXT_NAME}：进度跳转失败`, err);
					this.toast("进度跳转失败");
				}
			},

			isMusicBoxActuallyPlaying() {
				return !!(this.audio && !this.audio.paused && !this.audio.ended && this.audio.src);
			},

			// 只记录“确实被音乐盒暂停过”的本体BGM，免得将本来就关闭的音乐擅自叫醒
			pauseBackgroundMusic() {
				if (!ui.backgroundMusic) {
					return;
				}
				if (!ui.backgroundMusic.paused) {
					this.pausedBackgroundMusic = true;
				}
				ui.backgroundMusic.pause();
			},

			resumeBackgroundMusic() {
				if (!ui.backgroundMusic) {
					return;
				}
				if (this.isMusicBoxActuallyPlaying()) {
					return;
				}
				if (!this.pausedBackgroundMusic) {
					return;
				}
				this.pausedBackgroundMusic = false;
				if (!isNaN(ui.backgroundMusic.duration)) {
					Promise.resolve(ui.backgroundMusic.play()).catch(() => {});
				}
			},

			enforceBackgroundMusicPause() {
				if (!this.isMusicBoxActuallyPlaying()) {
					return;
				}
				this.pauseBackgroundMusic();
			},

			// 浏览器、Cordova、桌面窗口各触发各的事件，只监听一个总会漏，干脆都接住再由状态去重，虽然感觉好像没什么太大必要
			installPageLifecycleGuard() {
				if (this.pageLifecycleInstalled) {
					return;
				}
				this.pageLifecycleInstalled = true;
				const leave = () => {
					this.handlePageLeave();
				};
				const back = () => {
					this.handlePageBack();
				};
				document.addEventListener("visibilitychange", () => {
					if (document.hidden) {
						leave();
					} else {
						back();
					}
				});

				window.addEventListener("pagehide", leave);
				window.addEventListener("pageshow", back);
				window.addEventListener("blur", leave);
				window.addEventListener("focus", back);
				// 移动端 Cordova / WebView 场景
				document.addEventListener("pause", leave, false);
				document.addEventListener("resume", back, false);
			},

			// 本体菜单没有统一的“已打开”事件，只能定时看几个关键class，笨归笨但稳定
			installGameUIVisibilityGuard() {
				clearInterval(this.uiGuardTimer);
				this.uiGuardTimer = setInterval(() => {
					this.updateMusicBoxVisibilityByGameUI();
				}, 300);
				this.updateMusicBoxVisibilityByGameUI();
			},

			isGameTopUIOpened() {
				return !!(
					ui.window?.classList.contains("shortcutpaused") ||
					(ui.menuContainer && !ui.menuContainer.classList.contains("hidden")) ||
					ui.arena?.classList.contains("menupaused") ||
					ui.window?.classList.contains("touchinfohidden")
				);
			},

			updateMusicBoxVisibilityByGameUI() {
				if (!this.nodes.panel) {
					return;
				}
				const hide = this.isGameTopUIOpened();
				this.nodes.panel.classList.toggle("nnc-music-hidden-by-ui", hide);
			},

			handlePageLeave() {
				// 移动端会连续触发多个离开事件，后续事件不能把续播状态覆盖成暂停，所以这一块只能这样写
				const shouldResume =
					this.resumeWanted || this.pausedByVisibility || this.playing || this.isMusicBoxActuallyPlaying();
				this.resumeWanted = shouldResume;
				this.savePlaybackState(shouldResume, true, false, this.reloadSaving ? "reload" : "exit");
				if (getExtConfig("pauseOnBlur", true) === false || !this.audio || !shouldResume) {
					return;
				}
				if (ui.backgroundMusic) {
					ui.backgroundMusic.pause();
				}
				this.pausedByVisibility = true;
				if (!this.audio.paused) {
					this.audio.pause();
				}
				this.playing = false;
				this.stopBackgroundMusicGuard();
				this.refreshPanel("已暂停");
			},

			// 回到前台先看原本想不想继续播，不能见到 focus 就自作主张
			handlePageBack() {
				if (!this.resumeWanted) {
					if (this.isMusicBoxActuallyPlaying()) {
						this.pauseBackgroundMusic();
						this.startBackgroundMusicGuard();
					}
					return;
				}
				if (ui.backgroundMusic) {
					ui.backgroundMusic.pause();
				}
				if (this.isMusicBoxActuallyPlaying()) {
					this.playing = true;
					this.pausedByVisibility = false;
					this.pauseBackgroundMusic();
					this.startBackgroundMusicGuard();
					this.removeGestureResume();
					return;
				}
				this.pausedByVisibility = false;
				setTimeout(() => {
					this.resume(false, false).then((success) => {
						if (!success) {
							this.refreshPanel("点击任意位置继续播放");
							this.installGestureResume();
						}
					});
				}, 150);
			},

			// 不太确定某些WebView回到前台后是否会重新启动本体BGM，所以需要延迟复查一下
			installBackgroundMusicGuard() {
				if (this.bgmGuardInstalled) {
					return;
				}
				this.bgmGuardInstalled = true;
				const check = () => {
					setTimeout(() => this.enforceBackgroundMusicPause(), 600);
					setTimeout(() => this.enforceBackgroundMusicPause(), 1000);
					setTimeout(() => this.enforceBackgroundMusicPause(), 1500);
				};
				document.addEventListener("visibilitychange", () => {
					if (!document.hidden) {
						check();
					}
				});
				window.addEventListener("focus", check);
				window.addEventListener("pageshow", check);
				document.addEventListener("resume", check, false);
			},

			startBackgroundMusicGuard() {
				this.installBackgroundMusicGuard();
				clearInterval(this.bgmGuardTimer);
				this.enforceBackgroundMusicPause();
				this.bgmGuardTimer = setInterval(() => {
					this.enforceBackgroundMusicPause();
				}, 1500);
			},

			stopBackgroundMusicGuard() {
				clearInterval(this.bgmGuardTimer);
				this.bgmGuardTimer = null;
			},

			// 失败歌曲先排除，收藏模式再叠一层过滤，后面的上一首/下一首只和这份列表打交道
			getPlayableList() {
				let list = this.list.filter((item) => !this.failedFiles.has(item.file));
				if (this.mode == "favorite") {
					const favorites = new Set(this.favorites);
					list = list.filter((item) => favorites.has(item.file));
				}
				return list;
			},

			getListIndexByFile(file) {
				return this.list.findIndex((item) => item.file == file);
			},

			getNearestFavoriteIndex() {
				const favorites = new Set(this.favorites);
				if (!favorites.size || !this.list.length) {
					return -1;
				}
				for (let i = this.index; i < this.list.length; i++) {
					if (favorites.has(this.list[i].file)) {
						return i;
					}
				}
				for (let i = 0; i < this.index; i++) {
					if (favorites.has(this.list[i].file)) {
						return i;
					}
				}
				return -1;
			},

			getCurrent() {
				if (!this.list.length) {
					return null;
				}
				if (this.index < 0 || this.index >= this.list.length) {
					this.index = 0;
				}
				return this.list[this.index];
			},

			normalizeIndex(index) {
				if (!this.list.length) {
					return 0;
				}
				index = Number(index);
				if (!Number.isFinite(index)) {
					index = 0;
				}
				if (index < 0) {
					index = this.list.length - 1;
				}
				if (index >= this.list.length) {
					index = 0;
				}
				return index;
			},

			// 新歌曲的完整切换流程都收在这里，按钮、列表点击和自动下一首最终都会走同一条路
			async play(index = this.index) {
				if (!this.list.length) {
					await this.scan();
				}
				if (!this.list.length) {
					this.toast("未找到音乐文件");
					this.refreshPanel("未找到音乐文件");
					return false;
				}
				this.index = this.normalizeIndex(index);
				const item = this.getCurrent();
				const audio = this.ensureAudio();
				if (!item) {
					return false;
				}
				this.resetLyricsForItem(item);
				if (this.isMusicBoxActuallyPlaying()) {
					await this.fadeToVolume(0, 220);
				}
				audio.src = await this.resolveAudioUrl(item);
				audio.currentTime = 0;
				audio.volume = 0;
				audio.load();
				this.resumeWanted = true;
				this.removeGestureResume();
				this.pauseBackgroundMusic();

				try {
					await audio.play();
					await this.fadeToVolume(this.getFinalVolume(), 350);
					this.playing = true;
					this.pausedByVisibility = false;
					if (this.rememberSong) {
						saveExtConfig("lastIndex", this.index);
					}
					this.savePlaybackState(true, true);
					this.showPanelNow();
					this.refreshPanel();
					return true;
				} catch (err) {
					console.warn(`${EXT_NAME}：播放失败`, err);
					this.playing = false;
					this.resumeWanted = false;
					this.stopBackgroundMusicGuard();
					this.resumeBackgroundMusic();
					this.refreshPanel("点击播放以启动");
					return false;
				}
			},

			// 负责继续现有 src，当没有歌曲或还没装载时再交给play处理
			async resume(showPanel = true, useFade = true) {
				const audio = this.ensureAudio();
				if (!this.list.length) {
					return this.play(0);
				}
				if (!audio.src) {
					return this.play(this.index);
				}
				this.resumeWanted = true;
				this.pauseBackgroundMusic();
				try {
					if (useFade) {
						audio.volume = 0;
						await audio.play();
						await this.fadeToVolume(this.getFinalVolume(), 300);
					} else {
						audio.volume = this.getFinalVolume();
						await audio.play();
					}
					this.playing = true;
					this.pausedByVisibility = false;
					this.removeGestureResume();
					this.savePlaybackState(true, true);
					if (showPanel) {
						this.showPanelNow();
					}
					this.refreshPanel();
					return true;
				} catch (err) {
					console.warn(`${EXT_NAME}：继续播放失败`, err);
					this.playing = false;
					this.stopBackgroundMusicGuard();
					this.resumeBackgroundMusic();
					this.refreshPanel("点击播放以启动");
					return false;
				}
			},

			// 主动暂停直接取消下次自动续播，毕竟和切后台造成的暂停不一样
			pause() {
				if (!this.audio) {
					return;
				}
				this.resumeWanted = false;
				this.removeGestureResume();
				this.pausedByVisibility = false;
				this.audio.pause();
				this.playing = false;
				this.stopBackgroundMusicGuard();
				this.resumeBackgroundMusic();
				this.savePlaybackState(false, true);
				this.refreshPanel();
				this.showPanelNow();
			},

			// 停止时清掉续播存档
			stop() {
				if (!this.audio) {
					return;
				}
				this.resumeWanted = false;
				this.removeGestureResume();
				this.pausedByVisibility = false;
				this.audio.pause();
				this.audio.currentTime = 0;
				this.playing = false;
				this.stopBackgroundMusicGuard();
				this.resumeBackgroundMusic();
				this.clearPlaybackState();
				this.refreshPanel();
				this.showPanelNow();
			},

			toggle() {
				if (this.playing) {
					this.pause();
				} else {
					this.resume();
				}
			},

			// manual 用来区分点下一首和歌曲自然播完，顺序播放到末尾只在后者真正停止
			async next(manual = true) {
				if (!this.list.length) {
					await this.scan();
				}
				if (!this.list.length) {
					this.refreshPanel("未找到音乐文件");
					return;
				}
				const playable = this.getPlayableList();
				if (!playable.length) {
					if (this.mode == "favorite") {
						this.toast("暂无可播放的收藏歌曲");
					} else {
						this.toast("暂无可播放歌曲");
					}
					this.refreshPanel();
					return;
				}
				const current = this.getCurrent();
				let targetItem = null;
				if (this.mode == "singleLoop" && !manual && current && !this.failedFiles.has(current.file)) {
					targetItem = current;
				} else if (this.mode == "random") {
					if (playable.length == 1) {
						targetItem = playable[0];
					} else {
						do {
							targetItem = playable.randomGet();
						} while (current && targetItem.file == current.file);
					}
				} else {
					let playIndex = playable.findIndex((item) => current && item.file == current.file) + 1;
					if (playIndex >= playable.length) {
						if (this.mode == "order" && !manual) {
							this.stop();
							return;
						}
						playIndex = 0;
					}
					targetItem = playable[playIndex];
				}
				const nextIndex = this.getListIndexByFile(targetItem.file);
				if (nextIndex >= 0) {
					await this.play(nextIndex);
				}
			},

			async prev() {
				if (!this.list.length) {
					await this.scan();
				}
				if (!this.list.length) {
					this.refreshPanel("未找到音乐文件");
					return;
				}
				const playable = this.getPlayableList();
				if (!playable.length) {
					this.refreshPanel("暂无可播放歌曲");
					return;
				}
				const current = this.getCurrent();
				let playIndex = playable.findIndex((item) => current && item.file == current.file);
				if (playIndex < 0) {
					playIndex = 0;
				} else {
					playIndex--;
					if (playIndex < 0) {
						playIndex = playable.length - 1;
					}
				}
				const targetItem = playable[playIndex];
				const prevIndex = this.getListIndexByFile(targetItem.file);
				if (prevIndex >= 0) {
					await this.play(prevIndex);
				}
			},

			onEnded() {
				this.playing = false;
				this.next(false);
			},

			// 播放模式选择收藏时，会直接定位最近的收藏曲，合乎周礼
			cycleMode() {
				const current = this.mode;
				const index = modeOrder.indexOf(current);
				const next = modeOrder[(index + 1) % modeOrder.length];
				this.mode = next;
				if (next == "favorite") {
					const targetIndex = this.getNearestFavoriteIndex();
					if (targetIndex < 0) {
						this.toast("暂无收藏歌曲");
					} else if (this.playing) {
						this.play(targetIndex);
						return;
					} else {
						this.index = targetIndex;
					}
				}
				this.refreshPanel();
				this.showPanelNow();
			},

			toggleLock() {
				this.locked = !this.locked;
				this.refreshPanel();
				this.showPanelNow();
			},

			closePanelThisGame() {
				this.panelClosed = true;
				if (this.nodes.panel) {
					this.nodes.panel.style.display = "none";
				}
				clearTimeout(this.hideTimer);
			},

			openPanelThisGame() {
				this.panelClosed = false;
				this.createPanel();
				if (this.nodes.panel) {
					this.nodes.panel.style.display = "";
				}
				this.refreshPanel();
				this.showPanelNow();
			},

			// 悬浮窗只创建一次，然后全部都堆在这里，不然拆开成这一块，那一块也麻烦
			createPanel() {
				if (this.nodes.panel || !this.showPanel) {
					return;
				}

				const panel = createNode("nnc-music-box", ui.window || document.body);
				const main = createNode("nnc-music-main", panel);
				const icon = createNode("nnc-music-icon", main, "");
				const title = createNode("nnc-music-title", main);
				const titleTrack = createNode("nnc-music-title-track", title, "宁宁音乐盒");
				const close = createNode("nnc-music-close", main, "关");
				const lyric = createNode("nnc-music-lyric", panel, "");
				const controls = createNode("nnc-music-controls", panel);
				const lock = createNode("nnc-music-btn", controls, "锁定");
				const prev = createNode("nnc-music-btn", controls, "上一首");
				const toggle = createNode("nnc-music-btn nnc-music-toggle", controls, "播放");
				const next = createNode("nnc-music-btn", controls, "下一首");
				const mode = createNode("nnc-music-btn", controls, "循环");
				const progress = createNode("nnc-music-progress", panel);
				const currentTime = createNode("nnc-music-progress-time nnc-music-current-time", progress, "0:00");
				const progressSlider = document.createElement("input");
				progressSlider.className = "nnc-music-progress-slider";
				progressSlider.type = "range";
				progressSlider.min = "0";
				progressSlider.max = "1000";
				progressSlider.step = "1";
				progressSlider.value = "0";
				progress.appendChild(progressSlider);

				const durationTime = createNode("nnc-music-progress-time nnc-music-duration-time", progress, "0:00");
				const side = createNode("nnc-music-side", panel);
				const dragBtn = createNode("nnc-music-side-btn nnc-music-drag-btn", side, "拖");
				const volumeBtn = createNode("nnc-music-side-btn nnc-music-volume-btn", side, "音");
				const listBtn = createNode("nnc-music-side-btn nnc-music-list-btn", side, "列");
				const volume = createNode("nnc-music-volume", panel);
				const volumeText = createNode("nnc-music-volume-text", volume, "音量");
				const volumeSlider = document.createElement("input");
				volumeSlider.className = "nnc-music-volume-slider";
				volumeSlider.type = "range";
				volumeSlider.min = "0";
				volumeSlider.max = "100";
				volumeSlider.step = "1";
				volumeSlider.value = this.boxVolume;
				volume.appendChild(volumeSlider);

				const volumeValue = createNode("nnc-music-volume-value", volume, `${this.boxVolume}%`);
				const listPanel = createNode("nnc-music-list-panel", panel);
				const listHeader = createNode("nnc-music-list-header", listPanel);
				const listTitle = createNode("nnc-music-list-title", listHeader, "播放列表");
				const listClose = createNode("nnc-music-list-close", listHeader, "关");
				const listBody = createNode("nnc-music-list-body", listPanel);
				this.nodes = {
					panel,
					main,
					icon,
					title,
					titleTrack,
					close,
					lyric,
					controls,
					lock,
					prev,
					toggle,
					next,
					mode,
					progress,
					currentTime,
					progressSlider,
					durationTime,
					side,
					dragBtn,
					volumeBtn,
					listBtn,
					volume,
					volumeText,
					volumeSlider,
					volumeValue,
					listPanel,
					listHeader,
					listTitle,
					listClose,
					listBody,
				};

				bindClick(panel, () => {
					this.showPanelNow();
				});

				bindClick(close, () => {
					this.closePanelThisGame();
				});

				bindClick(lock, () => {
					this.toggleLock();
				});

				bindClick(prev, () => {
					this.prev();
				});

				bindClick(toggle, () => {
					this.toggle();
				});

				bindClick(next, () => {
					this.next(true);
				});

				bindClick(mode, () => {
					this.cycleMode();
				});

				bindClick(volumeBtn, () => {
					this.toggleVolumePanel();
				});

				bindClick(listBtn, () => {
					this.toggleListPanel();
				});

				bindClick(listClose, () => {
					this.closeListPanel();
				});

				volumeSlider.addEventListener("input", () => {
					this.boxVolume = volumeSlider.value;
					this.showPanelNow();
				});
				if (window.ResizeObserver) {
					this.titleResizeObserver = new ResizeObserver(() => {
						this.updateTitleMarquee();
					});
					this.titleResizeObserver.observe(title);
				}

				this.updateVolume();
				this.updateProgress();
				this.renderLyricsState(true);
				this.updateTitleMarquee();
				this.applyPanelPosition();
				this.installPanelDrag();
				this.installProgressDrag();
				this.installOutsideCloser();
				this.refreshListPanel();
			},

			isPopupOpen() {
				if (!this.nodes.panel) {
					return false;
				}
				return (
					this.nodes.panel.classList.contains("show-volume") ||
					this.nodes.panel.classList.contains("show-list")
				);
			},

			closePopups() {
				if (!this.nodes.panel) {
					return;
				}
				this.nodes.panel.classList.remove("show-volume");
				this.nodes.panel.classList.remove("show-list");
				this.resetHideTimer();
			},

			// 音量和播放列表互斥，两个弹层一起开会互相挡着，所以设定成打开其中一个，另外一个就会自动关闭
			toggleVolumePanel() {
				if (!this.nodes.panel) {
					return;
				}
				const opened = this.nodes.panel.classList.contains("show-volume");
				this.closePopups();
				if (!opened) {
					this.nodes.panel.classList.add("show-volume");
					clearTimeout(this.hideTimer);
				} else {
					this.resetHideTimer();
				}
				this.showPanelNow();
			},

			toggleListPanel() {
				if (!this.nodes.panel) {
					return;
				}
				const opened = this.nodes.panel.classList.contains("show-list");
				this.closePopups();
				if (!opened) {
					this.nodes.panel.classList.add("show-list");
					this.refreshListPanel();
					this.updateListPanelHeight();
					clearTimeout(this.hideTimer);
				} else {
					this.resetHideTimer();
				}
				this.showPanelNow();
			},

			closeListPanel() {
				if (!this.nodes.panel) {
					return;
				}
				this.nodes.panel.classList.remove("show-list");
				this.resetHideTimer();
			},

			installOutsideCloser() {
				if (this.outsideCloserInstalled) {
					return;
				}
				this.outsideCloserInstalled = true;
				const close = (evt) => {
					if (!this.nodes.panel) {
						return;
					}
					if (this.nodes.panel.contains(evt.target)) {
						return;
					}
					this.closePopups();
				};
				document.addEventListener(lib.config.touchscreen ? "touchend" : "click", close);
			},

			// 播放列表要跟着面板位置和界面缩放算尺寸，坐标系一多就出问题
			updateListPanelHeight() {
				if (!this.nodes.panel || !this.nodes.listPanel || !this.nodes.listBody) {
					return;
				}
				// rect 拿到的是缩放后的视觉坐标，style 写的是布局坐标，先除以 documentZoom 再排版
				const zoom = game.documentZoom || 1;
				const rect = this.nodes.panel.getBoundingClientRect();
				const panelLeft = rect.left / zoom;
				const winWidth = window.innerWidth / zoom;
				const winHeight = window.innerHeight / zoom;
				const gap = 12;
				const maxHeight = Math.max(180, winHeight - rect.bottom / zoom - gap);
				const bodyHeight = Math.max(120, maxHeight - 36);
				const listWidth = Math.min(680, winWidth - gap * 2);
				// 侧边按钮不在 panel 的矩形范围内，视觉中心需要向右补一半宽度
				const visualCenter = panelLeft + rect.width / zoom / 2 + 26;
				const viewportLeft = Math.max(gap, Math.min(winWidth - listWidth - gap, visualCenter - listWidth / 2));
				this.nodes.listPanel.style.left = `${viewportLeft - panelLeft}px`;
				this.nodes.listPanel.style.width = `${listWidth}px`;
				this.nodes.listPanel.style.maxWidth = `${winWidth - gap * 2}px`;
				this.nodes.listPanel.style.height = `${maxHeight}px`;
				this.nodes.listPanel.style.maxHeight = `${maxHeight}px`;
				this.nodes.listBody.style.height = `${bodyHeight}px`;
				this.nodes.listBody.style.maxHeight = `${bodyHeight}px`;
			},

			// 当前列表规模不大，直接重绘最省心，以后真加搜索或上百首歌，再考虑做局部更新
			refreshListPanel() {
				if (!this.nodes.listBody) {
					return;
				}
				this.nodes.listBody.innerHTML = "";
				if (!this.list.length) {
					createNode("nnc-music-list-empty", this.nodes.listBody, "暂无音乐文件");
					return;
				}
				const favorites = new Set(this.favorites);
				for (let i = 0; i < this.list.length; i++) {
					const item = this.list[i];
					const row = createNode("nnc-music-list-row", this.nodes.listBody);
					if (i == this.index) {
						row.classList.add("current");
					}
					const name = createNode("nnc-music-list-name", row, item.name);
					const rename = createNode("nnc-music-list-rename", row, "重命名");
					const favorite = favorites.has(item.file);
					const heart = createNode("nnc-music-list-heart", row, favorite ? "♥" : "♡");
					if (favorite) {
						heart.classList.add("active");
					}
					name.title = `磁盘文件名：${item.file}`;
					rename.title = "只修改音乐盒内的显示名称";

					bindClick(name, () => {
						this.play(i);
						this.refreshListPanel();
					});
					bindClick(rename, () => {
						this.renameDisplayName(item);
					});
					bindClick(heart, () => {
						this.toggleFavorite(item.file, heart);
					});
				}
			},

			// 由于位置存的是布局坐标，界面缩放一变就没得一点办法
			getSavedPanelPosition() {
				const pos = getExtConfig("panelPosition", null);
				if (!pos || typeof pos != "object") {
					return null;
				}
				if (!Number.isFinite(Number(pos.left)) || !Number.isFinite(Number(pos.top))) {
					return null;
				}
				return {
					left: Number(pos.left),
					top: Number(pos.top),
				};
			},

			// 拖动结束就异步落盘，无名杀退出前再补存一次
			savePanelPosition(left, top) {
				const position = {
					left: Math.round(left),
					top: Math.round(top),
				};
				this.panelPositionSaveTask = saveExtConfigAsync("panelPosition", position).catch((err) => {
					console.warn(`${EXT_NAME}：保存悬浮窗位置失败`, err);
				});
				return this.panelPositionSaveTask;
			},

			saveCurrentPanelPosition() {
				const panel = this.nodes.panel;
				if (!panel || panel.style.transform !== "none") {
					return this.panelPositionSaveTask || Promise.resolve();
				}
				// transform 为 none 说明 left/top 是早就写入的布局坐标，直接存这份
				// 不再从 rect 反推，省得界面缩放时算出偏移的值
				return this.savePanelPosition(parseFloat(panel.style.left),parseFloat(panel.style.top));
			},

			applyPanelPosition() {
				const panel = this.nodes.panel;
				if (!panel) {
					return;
				}
				const pos = this.getSavedPanelPosition();
				if (!pos) {
					return;
				}
				// 换设备、转屏或调过界面缩放后，旧位置可能已经在屏幕外，这么写恢复后按理应该拉回可见范围，然而并没有，不知道该怎么写了，所以选择放弃
				const parent = panel.offsetParent;
				let left = pos.left;
				let top = pos.top;
				if (parent) {
					left = Math.max(0, Math.min(parent.clientWidth - panel.offsetWidth, left));
					top = Math.max(0, Math.min(parent.clientHeight - panel.offsetHeight, top));
				}
				panel.style.left = `${left}px`;
				panel.style.top = `${top}px`;
				panel.style.transform = "none";
			},

			//无名杀把 body 缩放后，手指坐标、rect 和 left/top 分属不同坐标系，所以这拖动保存，只能将就着了
			installPanelDrag() {
				const panel = this.nodes.panel;
				const dragBtn = this.nodes.dragBtn;
				if (!panel || !dragBtn || panel.nncDragInstalled) {
					return;
				}
				panel.nncDragInstalled = true;
				const clamp = (value, min, max) => {
					return Math.max(min, Math.min(max, value));
				};
				const getPoint = (evt) => {
					const touch = (evt.touches && evt.touches[0]) || (evt.changedTouches && evt.changedTouches[0]);
					return touch || evt;
				};

				const startDrag = (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.dragging = true;
					clearTimeout(this.hideTimer);

					// 本体的界面缩放是给 body 加 transform: scale（ui.updatez，origin 左上），缩放开启时 rect 和 clientX 拿到的是缩放后的视觉坐标，而 fixed 面板的，包含块会从视口切到 body，style.left 写的是缩放前的布局坐标。直接把 rect 写进 style 会让面板在按下瞬间跳一下、拖动距离也和手指对不上，所以统一除以 documentZoom，和本体拖拽（ui/click）的换算保持一致，减 parentRect 可以兼容美化扩展给中间层加 transform 的情况
					const zoom = game.documentZoom || 1;
					const rect = panel.getBoundingClientRect();
					const parent = panel.offsetParent;
					const parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
					const startLeft = (rect.left - parentRect.left) / zoom;
					const startTop = (rect.top - parentRect.top) / zoom;

					// 默认位置依赖 transform 居中，拖动前先换成可持久化的 left/top，避免上面说到的问题
					panel.classList.add("dragging");
					dragBtn.classList.add("dragging");
					panel.style.left = `${startLeft}px`;
					panel.style.top = `${startTop}px`;
					panel.style.transform = "none";

					const point = getPoint(evt);
					const startX = point.clientX;
					const startY = point.clientY;
					const maxLeft = Math.max(0, (parent ? parent.clientWidth : window.innerWidth / zoom) - panel.offsetWidth);
					const maxTop = Math.max(0, (parent ? parent.clientHeight : window.innerHeight / zoom) - panel.offsetHeight);

					const move = (moveEvt) => {
						moveEvt.preventDefault();
						const movePoint = getPoint(moveEvt);
						const dx = (movePoint.clientX - startX) / zoom;
						const dy = (movePoint.clientY - startY) / zoom;
						panel.style.left = `${clamp(startLeft + dx, 0, maxLeft)}px`;
						panel.style.top = `${clamp(startTop + dy, 0, maxTop)}px`;
						this.updateListPanelHeight();
					};

					const end = () => {
						document.removeEventListener("mousemove", move);
						document.removeEventListener("mouseup", end);
						document.removeEventListener("touchmove", move);
						document.removeEventListener("touchend", end);
						document.removeEventListener("touchcancel", end);
						this.savePanelPosition(parseFloat(panel.style.left), parseFloat(panel.style.top));
						this.dragging = false;
						panel.classList.remove("dragging");
						dragBtn.classList.remove("dragging");
						this.resetHideTimer();
					};
					document.addEventListener("mousemove", move);
					document.addEventListener("mouseup", end);
					document.addEventListener("touchmove", move, { passive: false });
					document.addEventListener("touchend", end);
					document.addEventListener("touchcancel", end);
				};
				dragBtn.addEventListener("mousedown", startDrag);
				dragBtn.addEventListener("touchstart", startDrag, { passive: false });
			},

			// PointerEvent能用就统一处理鼠标和触摸，不太确定旧WebView有没有这东西，只能保留两套监听
			installProgressDrag() {
				const slider = this.nodes.progressSlider;
				if (!slider || slider.nncProgressInstalled) {
					return;
				}
				slider.nncProgressInstalled = true;
				const getValueByClientX = (clientX) => {
					const rect = slider.getBoundingClientRect();
					if (!rect.width || !Number.isFinite(clientX)) {
						return this.seekDragValue != null ? this.seekDragValue : Number(slider.value) || 0;
					}
					const rate = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
					return Math.round(rate * 1000);
				};

				const setValue = (value) => {
					value = Number(value);
					if (!Number.isFinite(value)) {
						return;
					}
					value = Math.max(0, Math.min(1000, value));
					this.seekDragValue = value;
					slider.value = value;
					this.previewProgress(value);
				};

				const finishSeek = () => {
					const value = this.seekDragValue != null ? this.seekDragValue : Number(slider.value) || 0;
					this.seekProgress(value);
					setTimeout(() => {
						this.seeking = false;
						this.seekDragValue = null;
						this.updateProgress();
						this.resetHideTimer();
					}, 420);
				};

				const start = (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					this.seeking = true;
					clearTimeout(this.hideTimer);
					const pointerId = evt.pointerId;
					try {
						slider.setPointerCapture(pointerId);
					} catch (e) {}
					setValue(getValueByClientX(evt.clientX));
					const move = (moveEvt) => {
						moveEvt.preventDefault();
						setValue(getValueByClientX(moveEvt.clientX));
					};
					const end = () => {
						finishSeek();
						try {
							slider.releasePointerCapture(pointerId);
						} catch (e) {}
						document.removeEventListener("pointermove", move);
						document.removeEventListener("pointerup", end);
						document.removeEventListener("pointercancel", end);
					};
					document.addEventListener("pointermove", move);
					document.addEventListener("pointerup", end);
					document.addEventListener("pointercancel", end);
				};

				if (window.PointerEvent) {
					slider.addEventListener("pointerdown", start);
				} else {
					const getPoint = (evt) => {
						const touch = evt.touches?.[0] || evt.changedTouches?.[0];
						return touch || evt;
					};
					const startOld = (evt) => {
						evt.preventDefault();
						evt.stopPropagation();
						this.seeking = true;
						clearTimeout(this.hideTimer);
						const point = getPoint(evt);
						setValue(getValueByClientX(point.clientX));
						const move = (moveEvt) => {
							moveEvt.preventDefault();
							const movePoint = getPoint(moveEvt);
							setValue(getValueByClientX(movePoint.clientX));
						};
						const end = () => {
							finishSeek();
							document.removeEventListener("mousemove", move);
							document.removeEventListener("mouseup", end);
							document.removeEventListener("touchmove", move);
							document.removeEventListener("touchend", end);
							document.removeEventListener("touchcancel", end);
						};
						document.addEventListener("mousemove", move);
						document.addEventListener("mouseup", end);
						document.addEventListener("touchmove", move, { passive: false });
						document.addEventListener("touchend", end);
						document.addEventListener("touchcancel", end);
					};
					slider.addEventListener("mousedown", startOld);
					slider.addEventListener("touchstart", startOld, { passive: false });
				}
			},

			setTitleText(text) {
				const title = this.nodes.title;
				const track = this.nodes.titleTrack;
				if (!title || !track) {
					return;
				}
				track.textContent = plainText(text);
				title.classList.remove("scrolling");
				this.updateTitleMarquee();
			},

			// 溢出时才滚动，短歌名居中
			updateTitleMarquee() {
				const title = this.nodes.title;
				const track = this.nodes.titleTrack;

				if (!title || !track) {
					return;
				}
				cancelAnimationFrame(this.titleMarqueeFrame);
				title.classList.remove("scrolling");
				this.titleMarqueeFrame = requestAnimationFrame(() => {
					if (!title.isConnected || !track.isConnected) {
						return;
					}
					const overflow = Math.ceil(track.scrollWidth - title.clientWidth);
					if (overflow <= 2) {
						title.style.removeProperty("--nnc-title-shift");
						title.style.removeProperty("--nnc-title-duration");
						return;
					}
					const duration = Math.max(7, Math.min(24, overflow / 28 + 5));
					title.style.setProperty("--nnc-title-shift", `${overflow}px`);
					title.style.setProperty("--nnc-title-duration", `${duration}s`);

					// 重置动画，避免连续切换同名歌曲时沿用上一次进度，不要问为什么，因为被坑过
					void track.offsetWidth;
					title.classList.add("scrolling");
				});
			},

			// 这是界面状态汇总点：歌名、按钮文字、模式和进度在这里一起对齐
			refreshPanel(message) {
				if (!this.nodes.panel) {
					return;
				}
				const current = this.getCurrent();
				const title = message || (current ? current.name : "未找到音乐文件");
				this.setTitleText(title);
				this.nodes.toggle.textContent = this.playing ? "暂停" : "播放";
				this.nodes.lock.textContent = this.locked ? "解锁" : "锁定";
				this.nodes.mode.textContent = modeMap[this.mode] || "循环";
				this.nodes.panel.classList.toggle("locked", !!this.locked);
				this.nodes.panel.classList.toggle("playing", !!this.playing);
				this.updateProgress();
				this.refreshListPanel();
			},

			// 有操作就展开重算倒计时
			showPanelNow() {
				if (!this.showPanel) {
					return;
				}
				this.createPanel();
				if (!this.nodes.panel || this.panelClosed) {
					return;
				}
				this.nodes.panel.style.display = "";
				this.nodes.panel.classList.remove("mini");
				this.updateTitleMarquee();
				this.resetHideTimer();
				this.updateListPanelHeight();
			},

			minimizePanel() {
				if (!this.nodes.panel || this.locked || this.panelClosed) {
					return;
				}
				this.nodes.panel.classList.add("mini");
				this.updateTitleMarquee();
			},

			// 锁定、拖动或弹层打开时不自动收起
			resetHideTimer() {
				clearTimeout(this.hideTimer);
				if (this.locked || this.panelClosed || !this.nodes.panel) {
					return;
				}
				if (this.isPopupOpen() || this.dragging) {
					return;
				}
				const time = this.autoHideTime;
				if (time == "off") {
					return;
				}
				const num = Number(time);
				if (!Number.isFinite(num) || num <= 0) {
					return;
				}
				this.hideTimer = setTimeout(() => {
					this.minimizePanel();
				}, num * 1000);
			},

			toast(str) {
				if (game.log) {
					game.log(`#y${EXT_NAME}：${str}`);
				}
			},
		};
		return box;
	};

	return {
		name: EXT_NAME,
		editable: false,

		//样式、歌词加载、作者头像联网获取
		precontent() {
			const styles = lib.assetURL + "extension/宁宁音乐盒/styles";
			lib.init.css(styles, "musicBox");

			if (window.nncLyrics) {
				window.nncLyricsReady = Promise.resolve(window.nncLyrics);
			} else if (!window.nncLyricsReady) {
				window.nncLyricsReady = new Promise((resolve) => {
					const script = document.createElement("script");
					script.id = "nnc-lyrics-loader";
					script.src = `${lib.assetURL}extension/${EXT_NAME}/nncLyrics.js`;
					script.onload = () => {
						resolve(window.nncLyrics || null);
					};
					script.onerror = (error) => {
						console.warn(`${EXT_NAME}：歌词解析组件加载失败`, error);
						resolve(null);
					};
					(document.head || document.documentElement).appendChild(script);
				});
			}

			if (!window.nncAvatar && !document.getElementById("nnc-avatar-loader")) {
				const script = document.createElement("script");
				script.id = "nnc-avatar-loader";
				script.src = `${lib.assetURL}extension/${EXT_NAME}/nncAvatar.js`;
				script.onload = () => {
					window.nncAvatar?.scan();
				};
				script.onerror = (error) => {
					console.warn("宁宁音乐盒：联网作者头像组件加载失败，将使用本地头像", error);
				};
				(document.head || document.documentElement).appendChild(script);
			}
		},
		// 部分启动流程里 ui.window 会晚一点出现，半秒轮询只负责等它，不做其他初始化重试
		content() {
			if (!game.nncMusicBox) {
				game.nncMusicBox = createMusicBox();
			}
			const init = () => {
				if (ui.window) {
					game.nncMusicBox.init();
					return true;
				}
				return false;
			};
			if (!init()) {
				const timer = setInterval(() => {
					if (init()) {
						clearInterval(timer);
					}
				}, 500);
			}
		},
		config: {
			fjx: {
				name: "<hr>",
				clear: true,
			},

			nnc_jiaruquliao: {
				name: '<span class="yellowtext">欢迎入群<font size="4px">▶▶▶</font></span><br>',
				clear: true,
				onclick() {
					if (!this.jiaqun) {
						const image = `${lib.assetURL}extension/${EXT_NAME}/NNC_QQ.jpg`;
						const more = ui.create.div(
							".jiaqun",
							`<div style="border:2px solid gray"><span><img style="width:333px" src="${image}"></span></div>`,
						);
						this.parentNode.insertBefore(more, this.nextSibling);
						this.jiaqun = more;
						this.innerHTML = '<span class="yellowtext">欢迎入群<font size="4px">▼▼▼</font></span><br>';
						return;
					}
					this.jiaqun.remove();
					delete this.jiaqun;
					this.innerHTML = '<span class="yellowtext">欢迎入群<font size="4px">▶▶▶</font></span><br>';
				},
			},

			showPanel: {
				name: "显示悬浮窗",
				init: true,
				intro: "开启后，对局顶部显示宁宁音乐盒的半透明控制栏，关闭后仍可在扩展界面中控制播放。",
				onclick(bool) {
					if (!game.nncMusicBox) {
						return;
					}
					if (bool) {
						game.nncMusicBox.openPanelThisGame();
					} else if (game.nncMusicBox.nodes.panel) {
						game.nncMusicBox.nodes.panel.style.display = "none";
					}
				},
			},

			startMini: {
				name: "进入对局默认收起",
				init: true,
				intro: "开启后，进入对局时悬浮窗默认显示歌曲名/歌词，需要点击后才展开控制栏。",
			},

			autoHideTime: {
				name: "悬浮窗自动收起",
				init: "5",
				intro: "悬浮窗未锁定时，经过指定时间后只保留歌名，若可显示歌词，则只保留歌词显示。",
				item: {
					3: "3秒",
					5: "5秒",
					10: "10秒",
					15: "15秒",
					off: "不自动收起",
				},
			},

			playbackRate: {
				name: "播放速度",
				init: "1.0",
				intro: "保持原本音调的情况下调整音乐盒歌曲的播放速度，即时生效。",
				item: {
					0.5: "×0.5",
					0.75: "×0.75",
					"1.0": "×1.0",
					1.25: "×1.25",
					1.5: "×1.5",
					"2.0": "×2.0",
				},
				onclick(value) {
					saveExtConfig("playbackRate", value);
					game.nncMusicBox?.updatePlaybackRate();
				},
			},

			playMode: {
				name: "播放模式",
				init: "listLoop",
				intro: "控制音乐盒播放到下一首歌时的行为。",
				item: {
					order: "顺序播放",
					listLoop: "列表循环",
					random: "随机播放",
					singleLoop: "单曲循环",
					favorite: "收藏播放",
				},
			},

			resumePolicy: {
				name: "恢复播放",
				init: "all",
				intro: "控制重新启动或重新进入游戏时，是否恢复此前播放的歌曲和状态。",
				item: {
					all: "重启与退出",
					reload: "仅重启",
					off: "关闭",
				},
				onclick(value) {
					saveExtConfig("resumePolicy", value);
					if (value === "off") {
						game.nncMusicBox?.clearPlaybackState();
					}
				},
			},

			rememberProgress: {
				name: "恢复后继续进度",
				init: true,
				intro: "从上次进度继续，需搭配恢复播放开关一起使用。",
			},

			showLyrics: {
				name: "显示歌词",
				init: true,
				intro: "仅支持歌曲同文件名lrc文件或音乐内嵌歌词，且需带时间进度，否则将会提示3秒后自动隐藏。",
				onclick(bool) {
					saveExtConfig("showLyrics", bool);
					const box = game.nncMusicBox;
					if (!box) {
						return;
					}
					if (!bool) {
						box.clearLyricsDisplay(true);
						return;
					}
					const item = box.getCurrent();
					if (item && box.audio?.src) {
						box.resetLyricsForItem(item);
						box.loadLyricsForItem(item);
					}
				},
			},

			pauseOnBlur: {
				name: "失焦时暂停音乐盒",
				init: true,
				intro: "切到其他应用、回到桌面或电脑端切换到其他窗口时，音乐盒会自动暂停正在播放的歌曲，回到游戏后恢复。",
			},

			openPanel: {
				clear: true,
				name: "<ins>打开本局悬浮窗</ins>",
				onclick() {
					game.nncMusicBox?.openPanelThisGame();
				},
			},

			importMusic: {
				clear: true,
				name: "<ins>导入音乐 / 歌词文件</ins>",
				async onclick() {
					if (!game.nncMusicBox) {
						game.nncMusicBox = createMusicBox();
					}
					await game.nncMusicBox.importMusicFiles();
				},
			},

			refreshList: {
				clear: true,
				name: "<ins>重新扫描音乐文件夹</ins>",
				async onclick() {
					if (!game.nncMusicBox) {
						return;
					}
					await game.nncMusicBox.scan();
					alert(`已扫描到 ${game.nncMusicBox.list.length} 首音乐`);
				},
			},

			prevMusic: {
				clear: true,
				name: "<ins>上一首</ins>",
				onclick() {
					game.nncMusicBox?.prev();
				},
			},

			toggleMusic: {
				clear: true,
				name: "<ins>播放 / 暂停</ins>",
				onclick() {
					game.nncMusicBox?.toggle();
				},
			},

			nextMusic: {
				clear: true,
				name: "<ins>下一首</ins>",
				onclick() {
					game.nncMusicBox?.next(true);
				},
			},

			stopMusic: {
				clear: true,
				name: "<ins>停止音乐盒并恢复本体音乐</ins>",
				onclick() {
					game.nncMusicBox?.stop();
				},
			},
		},

		help: {},
		package: {
			intro: "<br><b>宁宁音乐盒</b><br>可以读取本扩展 <b>music</b> 文件夹内的本地音频文件，并在对局界面顶部提供一个半透明悬浮播放器。<br><br>目前支持播放/暂停、停止、上一首/下一首、进度跳转、音量调节与播放速度调整，并提供顺序播放、列表循环、随机播放、单曲循环和收藏播放等播放模式。悬浮窗支持锁定、自动收起、进入对局默认收起、本局隐藏、拖动位置与位置保存，也可以通过播放列表选择歌曲、收藏歌曲和修改歌曲显示名称。<br><br>音乐盒支持读取同名 <b>LRC</b> 歌词文件，并会在没有LRC时尝试读取音频文件内部的同步歌词。没有可同步歌词时会短暂提示后自动隐藏歌词区域。<br><br>扩展支持恢复此前播放的歌曲与进度，可以选择重启与退出均恢复、仅重启恢复或关闭恢复。播放音乐盒歌曲时会自动暂停无名杀本体背景音乐，暂停或停止音乐盒后恢复本体音乐，而切换到其他应用或窗口时，也可以根据设置自动暂停并在返回游戏后继续。<br><br><b>使用说明：</b>如果需要播放自己的音乐，可以将音频文件复制到本扩展的 <b>music</b> 文件夹中，也可以点击下方的“导入音乐 / 歌词文件”按钮选择文件导入。建议使用复制方式放入文件，不建议直接移动文件，否则在部分移动端环境中可能只能扫描到文件名，却无法正常读取和播放。导入后通常可以立即使用，如果列表没有及时刷新，建议重新扫描或重启一次无名杀。<br><br>当前支持 <b>MP3、OGG、WAV、M4A、FLAC</b> 等音频格式。外置歌词需要使用与音乐相同的基础文件名，例如 <b>歌曲.mp3</b> 与 <b>歌曲.lrc</b>。<br><br>后续可能继续优化播放列表搜索、歌词时间校准、自定义外观与其他使用细节。<br><br><span class=greentext>注：悬浮窗、进度条和其他界面元素可能受到美化扩展或修改版无名杀本体的影响。使用过程中如果遇到问题，请先关闭所有美化扩展并在纯净本体中重新测试；懒人包同理，因为其中的本体代码可能已经被修改。确认不是美化扩展、懒人包或修改版客户端导致后，再进行反馈。</span>",
			author: `<samp id="宁宁澄"><small><strong>宁宁澄</strong></small></samp><style>#宁宁澄{animation:ningningchengbiaoqian 20s linear 1.5s infinite;font-family:shousha;font-size:40px;text-align:center;color:#00FFFF;text-shadow:-1.3px 0 2.2px #000,0 -1.3px 2.2px #000,1.3px 0 2.2px #000,0 1.3px 2.2px #000;}@keyframes ningningchengbiaoqian{0%{color:#00FFFF;opacity:1;}9%{opacity:0;}18%{color:#00FFFF;opacity:1;}27%{opacity:0;}36%{color:#00FFFF;opacity:1;}45%{opacity:0;}54%{color:#00FFFF;opacity:1;}63%{opacity:0;}72%{color:#00FFFF;opacity:1;}81%{opacity:0;}90%{color:#00FFFF;opacity:1;}99%{opacity:0;}}</style><b><img data-nnc-avatar data-size="100" src="${lib.assetURL}extension/宁宁音乐盒/NNC.jpg" style="width:50px;border-radius:100%;"><br>版本：V0.9.0</b>`,
			version: "0.9.0",
		},
		files: {
			character: [],
			card: [],
			skill: [],
			audio: [],
		},
	};
});
