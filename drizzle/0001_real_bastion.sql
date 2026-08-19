CREATE TABLE `bookxChapters` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text,
	`orderIndex` int NOT NULL DEFAULT 0,
	`generatedSegments` int NOT NULL DEFAULT 0,
	`totalSegments` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxChapters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxCharacters` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`role` varchar(100) NOT NULL,
	`voiceId` varchar(160),
	`voiceName` varchar(160),
	`accent` varchar(160),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxCharacters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxExports` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`format` enum('ACX','Podcast','InAudio package') NOT NULL,
	`status` enum('queued','ready','failed') NOT NULL DEFAULT 'queued',
	`storageKey` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxExports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxGenerationJobs` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`scope` enum('project','chapter','segment') NOT NULL,
	`status` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`totalSegments` int NOT NULL DEFAULT 0,
	`completedSegments` int NOT NULL DEFAULT 0,
	`failedSegments` int NOT NULL DEFAULT 0,
	`detail` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxGenerationJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxProjects` (
	`id` varchar(32) NOT NULL,
	`ownerId` int NOT NULL,
	`title` varchar(160) NOT NULL,
	`author` varchar(120),
	`kind` enum('audiobook','podcast') NOT NULL,
	`narrationStyle` enum('single','cast','narrator-cast') NOT NULL,
	`voiceModel` varchar(64) NOT NULL,
	`language` varchar(40) NOT NULL,
	`manuscriptName` varchar(255),
	`manuscriptStorageKey` varchar(512),
	`coverStyle` varchar(255),
	`status` enum('draft','producing','review','published') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxProjects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxPronunciations` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`word` varchar(255) NOT NULL,
	`alias` varchar(255),
	`phoneme` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxPronunciations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxProviderSettings` (
	`id` varchar(32) NOT NULL,
	`ownerId` int NOT NULL,
	`provider` enum('ElevenLabs','OpenAI') NOT NULL,
	`secretConfigured` int NOT NULL DEFAULT 0,
	`defaultModel` varchar(100),
	`defaultPace` varchar(80),
	`chapterGapMs` int NOT NULL DEFAULT 2000,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxProviderSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxSegments` (
	`id` varchar(32) NOT NULL,
	`chapterId` varchar(32) NOT NULL,
	`characterId` varchar(32),
	`text` text NOT NULL,
	`audioStorageKey` varchar(512),
	`orderIndex` int NOT NULL DEFAULT 0,
	`delivery` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxSegments_id` PRIMARY KEY(`id`)
);
