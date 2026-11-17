import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLEAN_ROOT = path.resolve(REPO_DIR, '..');
export const DATA_DIR = path.resolve(process.env.SF_DATA_DIR ?? path.join(REPO_DIR, 'data'));
export const EVENTS_DIR = path.join(DATA_DIR, 'events');
export const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
export const RUN_DIR = path.join(REPO_DIR, 'run');
export const DIST_DIR = path.join(REPO_DIR, 'dist');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.SF_PORT ?? 4477);
/** The one place outside clean-room the app may read (never write): Claude Code's transcripts, for importing past sessions. */
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
