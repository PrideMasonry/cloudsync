export interface Env {
	DEBOUNCE_KV: KVNamespace;
	GITHUB_OWNER: string;
	GITHUB_REPO: string;
	DEBOUNCE_SECONDS: string;
	GITHUB_PAT: string;
	DROPBOX_APP_SECRET: string;
	GDRIVE_CHANNEL_TOKEN: string;
}

const DEBOUNCE_KEY = 'last-dispatch';

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const aBuf = enc.encode(a);
	const bBuf = enc.encode(b);
	if (aBuf.byteLength !== bBuf.byteLength) return false;
	let mismatch = 0;
	for (let i = 0; i < aBuf.byteLength; i++) {
		mismatch |= aBuf[i] ^ bBuf[i];
	}
	return mismatch === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function shouldDispatch(env: Env): Promise<boolean> {
	const windowSeconds = Number(env.DEBOUNCE_SECONDS || '45');
	const last = await env.DEBOUNCE_KV.get(DEBOUNCE_KEY);
	const now = Date.now();
	if (last && now - Number(last) < windowSeconds * 1000) {
		return false;
	}
	await env.DEBOUNCE_KV.put(DEBOUNCE_KEY, String(now), { expirationTtl: windowSeconds * 4 });
	return true;
}

async function dispatchSync(env: Env, source: 'gdrive' | 'dropbox'): Promise<void> {
	const eventType = source === 'gdrive' ? 'gdrive-changed' : 'dropbox-changed';
	const res = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.GITHUB_PAT}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'gdrive-dropbox-sync-webhook',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ event_type: eventType, client_payload: { source } }),
	});
	if (!res.ok) {
		console.error(`repository_dispatch failed: ${res.status} ${await res.text()}`);
	}
}

async function handleDropboxVerify(url: URL): Promise<Response> {
	const challenge = url.searchParams.get('challenge');
	if (!challenge) return new Response('missing challenge', { status: 400 });
	return new Response(challenge, {
		status: 200,
		headers: { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' },
	});
}

async function handleDropboxNotification(request: Request, env: Env): Promise<Response> {
	const rawBody = await request.text();
	const signature = request.headers.get('X-Dropbox-Signature') || '';
	const expected = await hmacSha256Hex(env.DROPBOX_APP_SECRET, rawBody);
	if (!(await timingSafeEqual(signature, expected))) {
		return new Response('invalid signature', { status: 403 });
	}
	if (await shouldDispatch(env)) {
		await dispatchSync(env, 'dropbox');
	}
	return new Response('ok', { status: 200 });
}

async function handleGDriveNotification(request: Request, env: Env): Promise<Response> {
	const channelToken = request.headers.get('X-Goog-Channel-Token') || '';
	if (!(await timingSafeEqual(channelToken, env.GDRIVE_CHANNEL_TOKEN))) {
		return new Response('invalid channel token', { status: 403 });
	}
	const resourceState = request.headers.get('X-Goog-Resource-State') || '';
	// "sync" is just the initial ack sent when the channel is created, not a real change.
	if (resourceState !== 'sync' && (await shouldDispatch(env))) {
		await dispatchSync(env, 'gdrive');
	}
	return new Response('ok', { status: 200 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/dropbox') {
			if (request.method === 'GET') return handleDropboxVerify(url);
			if (request.method === 'POST') return handleDropboxNotification(request, env);
		}

		if (url.pathname === '/gdrive' && request.method === 'POST') {
			return handleGDriveNotification(request, env);
		}

		if (url.pathname === '/' && request.method === 'GET') {
			return new Response('gdrive-dropbox-sync webhook receiver: ok', { status: 200 });
		}

		return new Response('not found', { status: 404 });
	},
};
