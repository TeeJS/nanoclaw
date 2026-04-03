/**
 * Meetings Watcher — NanoClaw startup registration module
 *
 * Registers the meetings group (Discord channel 1485756865391497236) with NAS
 * access and creates the 8-hour scheduled task that polls for new recordings.
 *
 * This is not a real channel — it has no server and does not own any JIDs.
 * DiscordChannel handles all inbound/outbound messaging for dc: JIDs.
 * This module purely handles group registration and task creation at startup.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import {
  createTask,
  getTasksForGroup,
  setRegisteredGroup,
  storeChatMetadata,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MEETINGS_JID = 'dc:1485756865391497236';
const MEETINGS_FOLDER = 'meetings';
const MEETINGS_GROUP_NAME = 'Meeting Transcripts';

const SCAN_PROMPT =
  'Check /workspace/extra/nas/skybox/meeting_audio/ for new WAV files and process any you find. Follow the instructions in CLAUDE.md.';

// ── Channel implementation ───────────────────────────────────────────────────

export class MeetingsWatcher implements Channel {
  name = 'meetings-watcher';
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.ensureGroupFolder();
    this.ensureGroupRegistered();
    this.ensureScheduledTask();
    logger.info('Meetings watcher initialized');
  }

  // Outbound messages for this JID are handled by DiscordChannel
  async sendMessage(_jid: string, _text: string): Promise<void> {}

  isConnected(): boolean {
    return true;
  }

  // Do not claim dc: JIDs — DiscordChannel owns them for outbound routing
  ownsJid(_jid: string): boolean {
    return false;
  }

  async disconnect(): Promise<void> {}

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}

  // ── Setup helpers ──────────────────────────────────────────────────────────

  private ensureGroupFolder(): void {
    const groupDir = path.join(GROUPS_DIR, MEETINGS_FOLDER);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    logger.info({ dir: groupDir }, 'Meetings: group folder ensured');
  }

  private ensureGroupRegistered(): void {
    const groups = this.opts.registeredGroups();

    const group: RegisteredGroup = {
      name: MEETINGS_GROUP_NAME,
      folder: MEETINGS_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: groups[MEETINGS_JID]?.added_at ?? new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
      alwaysIsolated: true, // pipeline group — each run starts fresh from CLAUDE.md
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/mnt/nas',
            containerPath: 'nas', // security module prepends /workspace/extra/
            readonly: false,
          },
        ],
        timeout: 3 * 60 * 60 * 1000, // 3 hours — long recordings on CPU can take a while
      },
    };

    setRegisteredGroup(MEETINGS_JID, group);
    groups[MEETINGS_JID] = group;

    storeChatMetadata(
      MEETINGS_JID,
      new Date().toISOString(),
      MEETINGS_GROUP_NAME,
      'discord',
      false,
    );

    logger.info(
      { jid: MEETINGS_JID, folder: MEETINGS_FOLDER },
      'Meetings group registered',
    );
  }

  private ensureScheduledTask(): void {
    const existing = getTasksForGroup(MEETINGS_FOLDER);
    if (existing.some((t) => t.status === 'active')) {
      logger.debug('Meetings: scheduled task already exists, skipping creation');
      return;
    }

    // Schedule first run at the next 8-hour boundary (0:00, 8:00, 16:00)
    const now = new Date();
    const currentHour = now.getHours();
    const nextBoundaryHour = Math.ceil((currentHour + 1) / 8) * 8;
    const nextRun = new Date(now);
    nextRun.setHours(nextBoundaryHour % 24, 0, 0, 0);
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
      nextRun.setHours(0, 0, 0, 0);
    }

    createTask({
      id: randomUUID(),
      group_folder: MEETINGS_FOLDER,
      chat_jid: MEETINGS_JID,
      prompt: SCAN_PROMPT,
      schedule_type: 'cron',
      schedule_value: '0 */8 * * *',
      context_mode: 'isolated',
      next_run: nextRun.toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info({ nextRun }, 'Meetings: created 8-hour cron task');
  }
}

// ── Self-registration (runs on import) ───────────────────────────────────────

registerChannel('meetings-watcher', (opts: ChannelOpts) => {
  return new MeetingsWatcher(opts);
});
