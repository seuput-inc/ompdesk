export async function exerciseNativeMedia(
	evaluate: (expression: string) => Promise<unknown>,
	files: { audio: string; video: string },
	tabId: string,
): Promise<unknown> {
	return evaluate(`(async ({ audio, video, tabId }) => {
		const metrics = [];
		const failures = [];
		const violations = [];
		const elements = [];
		const urls = [];
		const onViolation = event => {
			if (event.effectiveDirective === 'media-src') violations.push(event.effectiveDirective);
		};
		document.addEventListener('securitypolicyviolation', onViolation);
		// macOS 14.0's WKWebView predates Promise.withResolvers.
		const wait = (element, kind, event, ready, start) => new Promise((resolve, reject) => {
			const finish = error => {
				clearTimeout(timer);
				element.removeEventListener(event, success);
				element.removeEventListener('error', failed);
				if (error) reject(error); else resolve();
			};
			const success = () => { if (ready()) finish(); };
			const failed = () => finish(new Error(kind + ':' + event + ':media-error-' + (element.error?.code ?? 0)));
			const timer = setTimeout(() => finish(new Error(kind + ':' + event + ':timeout')), 10000);
			element.addEventListener(event, success);
			element.addEventListener('error', failed);
			try { if (start) start(); success(); } catch { finish(new Error(kind + ':' + event + ':failed')); }
		});
		try {
			for (const [kind, path] of [['audio', audio], ['video', video]]) {
				try {
					let source;
					try { source = await window.omp.fs.mediaStream(path, tabId); }
					catch { throw new Error(kind + ':media-stream-request-failed'); }
					if (!source?.ok || typeof source.url !== 'string') throw new Error(kind + ':media-stream-rejected');
					urls.push(source.url);
					const element = document.createElement(kind);
					elements.push(element);
					element.preload = 'auto';
					element.muted = true;
					element.controls = true;
					document.body.appendChild(element);
					await wait(element, kind, 'loadedmetadata', () => element.readyState >= 1, () => {
						element.src = source.url;
						element.load();
					});
					if (!Number.isFinite(element.duration) || element.duration <= 0) throw new Error(kind + ':invalid-duration');
					if (kind === 'video' && (element.videoWidth <= 0 || element.videoHeight <= 0)) throw new Error('video:missing-dimensions');
					await wait(element, kind, 'loadeddata', () => element.readyState >= 2);
					const destination = element.duration / 2;
					await wait(element, kind, 'seeked', () => !element.seeking && Math.abs(element.currentTime - destination) < 0.05, () => {
						element.currentTime = destination;
					});
					metrics.push({ kind, duration: element.duration, readyState: element.readyState,
						currentTime: element.currentTime, seekableRanges: element.seekable.length,
						width: kind === 'video' ? element.videoWidth : 0,
						height: kind === 'video' ? element.videoHeight : 0,
						errorCode: element.error?.code ?? 0 });
				} catch (error) {
					const reason = error instanceof Error ? error.message : '';
					failures.push(/^(audio|video):[a-z0-9:-]+$/.test(reason) ? reason : kind + ':consumer-failed');
				}
			}
		} finally {
			for (const element of elements) {
				element.pause();
				element.removeAttribute('src');
				element.load();
				element.remove();
			}
			for (const url of urls) {
				try { await window.omp.fs.releaseMediaStream(url); }
				catch { failures.push('media:release-failed'); }
			}
			document.removeEventListener('securitypolicyviolation', onViolation);
		}
		if (violations.length) failures.push('media:csp-media-src');
		if (failures.length) throw new Error(failures.join('; '));
		return { metrics, cspEffectiveDirectives: violations };
	})(${JSON.stringify({ audio: files.audio, video: files.video, tabId })})`);
}
