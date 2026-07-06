#!/usr/bin/env node
// Renews the Google Drive push-notification channel that tells our webhook
// receiver "something changed in this Drive." Drive channels don't auto-renew
// and there's no folder-scoped watch API, so this re-registers a whole-Drive
// `changes.watch` channel on a schedule (see README for that trade-off).
//
// Reuses the access token rclone already has (forcing rclone to refresh it
// first) instead of reimplementing OAuth, since this rclone setup uses
// rclone's built-in OAuth client and has no client_secret of its own to use.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RCLONE_CONF_PATH = join(homedir(), '.config', 'rclone', 'rclone.conf');
const STATE_DIR = join(homedir(), '.cache', 'gdrive-watch');
const STATE_PATH = join(STATE_DIR, 'channel-state.json');

const WORKER_BASE_URL = requireEnv('WORKER_BASE_URL');
const GDRIVE_CHANNEL_TOKEN = requireEnv('GDRIVE_CHANNEL_TOKEN');
const EXPIRATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days; renewed every 12h, ample margin.

function requireEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`missing required env var ${name}`);
	return value;
}

function readGdriveAccessToken() {
	const conf = readFileSync(RCLONE_CONF_PATH, 'utf8');
	const section = conf.split(/\n(?=\[)/).find((block) => block.startsWith('[gdrive]'));
	if (!section) throw new Error('no [gdrive] remote found in rclone.conf');
	const match = section.match(/^token\s*=\s*(\{.*\})\s*$/m);
	if (!match) throw new Error('no token found in [gdrive] remote');
	return JSON.parse(match[1]).access_token;
}

function loadPreviousChannel() {
	if (!existsSync(STATE_PATH)) return null;
	try {
		return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
	} catch {
		return null;
	}
}

async function driveFetch(path, accessToken, init = {}) {
	const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
			...init.headers,
		},
	});
	return res;
}

async function stopPreviousChannel(previous, accessToken) {
	if (!previous) return;
	const res = await driveFetch('/channels/stop', accessToken, {
		method: 'POST',
		body: JSON.stringify({ id: previous.id, resourceId: previous.resourceId }),
	});
	// A 404/410 just means it already expired/was cleaned up - fine either way.
	if (!res.ok && res.status !== 404 && res.status !== 410) {
		console.warn(`warning: failed to stop previous channel: ${res.status} ${await res.text()}`);
	}
}

async function main() {
	console.log('forcing rclone to refresh its Drive OAuth token...');
	execFileSync('rclone', ['lsf', 'gdrive:', '--max-depth', '1'], { stdio: 'inherit' });

	const accessToken = readGdriveAccessToken();
	const previous = loadPreviousChannel();

	await stopPreviousChannel(previous, accessToken);

	console.log('fetching a fresh startPageToken...');
	const tokenRes = await driveFetch('/changes/startPageToken', accessToken);
	if (!tokenRes.ok) throw new Error(`startPageToken failed: ${tokenRes.status} ${await tokenRes.text()}`);
	const { startPageToken } = await tokenRes.json();

	const channelId = crypto.randomUUID();
	const expiration = String(Date.now() + EXPIRATION_MS);

	console.log('registering new changes.watch channel...');
	const watchRes = await driveFetch(`/changes/watch?pageToken=${encodeURIComponent(startPageToken)}`, accessToken, {
		method: 'POST',
		body: JSON.stringify({
			id: channelId,
			type: 'web_hook',
			address: `${WORKER_BASE_URL}/gdrive`,
			token: GDRIVE_CHANNEL_TOKEN,
			expiration,
		}),
	});
	if (!watchRes.ok) throw new Error(`changes.watch failed: ${watchRes.status} ${await watchRes.text()}`);
	const watch = await watchRes.json();

	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify({ id: watch.id, resourceId: watch.resourceId }, null, 2));

	console.log(`registered channel ${watch.id}, expires ${new Date(Number(watch.expiration)).toISOString()}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
