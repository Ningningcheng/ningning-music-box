(() => {
	// 若有扩展已经加载本组件时，不重复注册监听
	if (window.nncAvatar) {
		window.nncAvatar.scan?.();
		return;
	}
	const DEFAULT_QQ = "3602348854";
	const LOAD_TIMEOUT = 5000;
	const CACHE_HOURS = 6;

	/**
	 * 获取联网 QQ 头像地址
	 */
	const getRemoteUrl = (qq = DEFAULT_QQ, size = 100) => {
		const cacheStamp = Math.floor(
			Date.now() / (CACHE_HOURS * 60 * 60 * 1000)
		);
		return ["https://q1.qlogo.cn/g",`?b=qq`,`&nk=${encodeURIComponent(qq)}`,`&s=${encodeURIComponent(size)}`,`&t=${cacheStamp}`].join("");
	};

	/**
	 * 给一个 img 元素应用联网头像
	 *
	 * 加载网络头像期间继续显示原来的本地图片；
	 * 网络加载失败时不会改变本地备用头像。
	 */
	const apply = (img, options = {}) => {
		if (!(img instanceof HTMLImageElement)) {
			return false;
		}
		const state = img.dataset.nncAvatarState;
		if (state === "loading" || state === "ready") {
			return false;
		}
		const qq =options.qq ||img.dataset.qq ||DEFAULT_QQ;
		const size =Number(options.size) ||Number(img.dataset.size) ||100;
		const fallback =options.fallback ||img.dataset.fallback ||img.getAttribute("src") ||"";
		if (fallback) {
			img.dataset.fallback = fallback;
		}
		const remoteUrl = getRemoteUrl(qq, size);
		const probe = new Image();
		let finished = false;

		const finish = success => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			if (success) {
				img.src = remoteUrl;
				img.dataset.nncAvatarState = "ready";
			} else {
				if (fallback) {
					img.src = fallback;
				}
				img.dataset.nncAvatarState = "fallback";
			}
		};

		const timer = setTimeout(() => {
			finish(false);
		}, LOAD_TIMEOUT);
		probe.onload = () => {
			finish(probe.naturalWidth > 0 &&probe.naturalHeight > 0);
		};
		probe.onerror = () => {
			finish(false);
		};
		img.dataset.nncAvatarState = "loading";
		probe.src = remoteUrl;
		return true;
	};

	/**
	 * 扫描页面中等待替换的作者头像
	 */
	const scan = (root = document) => {
		if (!root) {
			return;
		}
		if (root instanceof HTMLImageElement &&root.matches("[data-nnc-avatar]")) {
			apply(root);
		}
		if (!root.querySelectorAll) {
			return;
		}
		root.querySelectorAll("img[data-nnc-avatar]").forEach(img => {
				apply(img);
			});
	};

	/**
	 * 监听后续动态创建的扩展配置页面
	 */
	const observer = new MutationObserver(records => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!(node instanceof Element)) {
					continue;
				}
				scan(node);
			}
		}
	});

	window.nncAvatar = {
		apply,
		scan,
		getRemoteUrl,
	};

	const start = () => {
		scan(document);
		if (document.documentElement) {
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true,
			});
		}
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded",start,{
				once: true,
			}
		);
	} else {
		start();
	}
})();
