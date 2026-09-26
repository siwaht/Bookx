CREATE TABLE `bookxAnalysisJobs` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`totalSteps` integer DEFAULT 0 NOT NULL,
	`completedSteps` integer DEFAULT 0 NOT NULL,
	`message` text,
	`cancelRequested` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`heartbeatAt` integer,
	`startedAt` integer,
	`finishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxAnalysisJobs_project_idx` ON `bookxAnalysisJobs` (`projectId`,`kind`,`createdAt`);--> statement-breakpoint
CREATE TABLE `bookxChapters` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`orderIndex` integer DEFAULT 0 NOT NULL,
	`included` integer DEFAULT 1 NOT NULL,
	`kind` text DEFAULT 'chapter' NOT NULL,
	`attributionHash` text,
	`sceneHash` text,
	`generatedSegments` integer DEFAULT 0 NOT NULL,
	`totalSegments` integer DEFAULT 0 NOT NULL,
	`audioStorageKey` text,
	`audioDurationMs` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxChapters_project_idx` ON `bookxChapters` (`projectId`,`orderIndex`);--> statement-breakpoint
CREATE TABLE `bookxCharacters` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`voiceId` text,
	`voiceName` text,
	`accent` text,
	`voiceRationale` text,
	`sampleLine` text,
	`previewStorageKey` text,
	`assignmentConfidence` integer,
	`assignmentSource` text DEFAULT 'manual' NOT NULL,
	`isNarrator` integer DEFAULT 0 NOT NULL,
	`gender` text,
	`ageGroup` text,
	`aliases` text,
	`description` text,
	`lineCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxCharacters_project_idx` ON `bookxCharacters` (`projectId`);--> statement-breakpoint
CREATE TABLE `bookxExports` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`format` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`storageKey` text,
	`durationMs` integer,
	`bytes` integer,
	`error` text,
	`detail` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxExports_project_idx` ON `bookxExports` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `bookxGenerationJobs` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`totalSegments` integer DEFAULT 0 NOT NULL,
	`completedSegments` integer DEFAULT 0 NOT NULL,
	`failedSegments` integer DEFAULT 0 NOT NULL,
	`skippedSegments` integer DEFAULT 0 NOT NULL,
	`provider` text,
	`model` text,
	`voiceId` text,
	`cursorSegmentId` text,
	`cursorIndex` integer DEFAULT 0 NOT NULL,
	`rewindSegments` integer DEFAULT 1 NOT NULL,
	`leaseOwner` text,
	`leaseExpiresAt` integer,
	`heartbeatAt` integer,
	`pauseRequested` integer DEFAULT 0 NOT NULL,
	`cancelRequested` integer DEFAULT 0 NOT NULL,
	`renderedBytes` integer DEFAULT 0 NOT NULL,
	`renderedDurationMs` integer DEFAULT 0 NOT NULL,
	`startedAt` integer,
	`finishedAt` integer,
	`detail` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxGenerationJobs_project_idx` ON `bookxGenerationJobs` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `bookxProjects` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`kind` text NOT NULL,
	`narrationStyle` text NOT NULL,
	`voiceProvider` text DEFAULT 'ElevenLabs' NOT NULL,
	`voiceModel` text NOT NULL,
	`languageModelProvider` text DEFAULT 'Cloudflare' NOT NULL,
	`languageModel` text DEFAULT '@cf/openai/gpt-oss-120b' NOT NULL,
	`language` text NOT NULL,
	`manuscriptName` text,
	`manuscriptStorageKey` text,
	`coverStyle` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`soundEffectsEnabled` integer DEFAULT 0 NOT NULL,
	`backgroundMusicEnabled` integer DEFAULT 0 NOT NULL,
	`soundLevel` text DEFAULT 'very-subtle' NOT NULL,
	`soundSource` text DEFAULT 'auto' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxProjects_owner_idx` ON `bookxProjects` (`ownerId`);--> statement-breakpoint
CREATE TABLE `bookxPronunciations` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`word` text NOT NULL,
	`alias` text,
	`phoneme` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxPronunciations_project_idx` ON `bookxPronunciations` (`projectId`);--> statement-breakpoint
CREATE TABLE `bookxProviderSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` integer NOT NULL,
	`provider` text NOT NULL,
	`secretConfigured` integer DEFAULT 0 NOT NULL,
	`defaultModel` text,
	`defaultTtsModel` text,
	`defaultSttModel` text,
	`defaultLlmModel` text,
	`defaultPace` text,
	`chapterGapMs` integer DEFAULT 2000 NOT NULL,
	`fallbackProvider` text,
	`fallbackEnabled` integer DEFAULT 0 NOT NULL,
	`apiBaseUrl` text,
	`apiKey` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxProviderSettings_owner_idx` ON `bookxProviderSettings` (`ownerId`,`provider`);--> statement-breakpoint
CREATE TABLE `bookxSegments` (
	`id` text PRIMARY KEY NOT NULL,
	`chapterId` text NOT NULL,
	`characterId` text,
	`text` text NOT NULL,
	`audioStorageKey` text,
	`orderIndex` integer DEFAULT 0 NOT NULL,
	`delivery` text,
	`textHash` text,
	`voiceProvider` text,
	`voiceModel` text,
	`voiceId` text,
	`audioMimeType` text,
	`audioBytes` integer,
	`audioDurationMs` integer,
	`renderAttempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`renderedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxSegments_chapter_idx` ON `bookxSegments` (`chapterId`,`orderIndex`);--> statement-breakpoint
CREATE INDEX `bookxSegments_character_idx` ON `bookxSegments` (`characterId`);--> statement-breakpoint
CREATE TABLE `bookxSoundCues` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`chapterId` text NOT NULL,
	`segmentId` text NOT NULL,
	`kind` text NOT NULL,
	`tag` text NOT NULL,
	`placement` text DEFAULT 'after' NOT NULL,
	`source` text DEFAULT 'llm' NOT NULL,
	`note` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`gainDb` integer DEFAULT 0 NOT NULL,
	`assetId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxSoundCues_project_idx` ON `bookxSoundCues` (`projectId`);--> statement-breakpoint
CREATE INDEX `bookxSoundCues_chapter_idx` ON `bookxSoundCues` (`chapterId`);--> statement-breakpoint
CREATE TABLE `bookxStudioAssets` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`storageKey` text,
	`durationMs` integer DEFAULT 0 NOT NULL,
	`promptHash` text,
	`tag` text,
	`source` text,
	`meanVolumeDb` integer,
	`peakVolumeDb` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxStudioAssets_project_idx` ON `bookxStudioAssets` (`projectId`);--> statement-breakpoint
CREATE INDEX `bookxStudioAssets_prompt_idx` ON `bookxStudioAssets` (`promptHash`);--> statement-breakpoint
CREATE TABLE `bookxTimelineClips` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`assetId` text,
	`segmentId` text,
	`trackType` text NOT NULL,
	`startMs` integer DEFAULT 0 NOT NULL,
	`durationMs` integer DEFAULT 0 NOT NULL,
	`volume` integer DEFAULT 80 NOT NULL,
	`fadeInMs` integer DEFAULT 0 NOT NULL,
	`fadeOutMs` integer DEFAULT 0 NOT NULL,
	`duckUnderNarration` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxTimelineClips_project_idx` ON `bookxTimelineClips` (`projectId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`openId` text NOT NULL,
	`name` text,
	`email` text,
	`loginMethod` text,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastSignedIn` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_openId_unique` ON `users` (`openId`);