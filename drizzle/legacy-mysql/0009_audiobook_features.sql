CREATE TABLE `bookxAnalysisJobs` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`kind` enum('cast','scenes','sounds') NOT NULL,
	`status` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`totalSteps` int NOT NULL DEFAULT 0,
	`completedSteps` int NOT NULL DEFAULT 0,
	`message` varchar(512),
	`cancelRequested` int NOT NULL DEFAULT 0,
	`detail` json,
	`heartbeatAt` timestamp,
	`startedAt` timestamp,
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxAnalysisJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxSoundCues` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`chapterId` varchar(32) NOT NULL,
	`segmentId` varchar(32) NOT NULL,
	`kind` enum('sfx','music') NOT NULL,
	`tag` varchar(64) NOT NULL,
	`placement` enum('before','after') NOT NULL DEFAULT 'after',
	`source` enum('llm','keyword','manual') NOT NULL DEFAULT 'llm',
	`note` varchar(255),
	`enabled` int NOT NULL DEFAULT 1,
	`gainDb` int NOT NULL DEFAULT 0,
	`assetId` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxSoundCues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `bookxChapters` MODIFY COLUMN `body` mediumtext;--> statement-breakpoint
ALTER TABLE `bookxCharacters` MODIFY COLUMN `assignmentSource` enum('manual','llm','auto') NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `included` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `kind` varchar(24) DEFAULT 'chapter' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `attributionHash` varchar(64);--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `sceneHash` varchar(64);--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `isNarrator` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `gender` varchar(24);--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `ageGroup` varchar(24);--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `aliases` json;--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `description` varchar(512);--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `lineCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `soundEffectsEnabled` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `backgroundMusicEnabled` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `soundLevel` varchar(16) DEFAULT 'very-subtle' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `soundSource` varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxStudioAssets` ADD `promptHash` varchar(64);--> statement-breakpoint
ALTER TABLE `bookxStudioAssets` ADD `tag` varchar(64);--> statement-breakpoint
ALTER TABLE `bookxStudioAssets` ADD `source` varchar(24);--> statement-breakpoint
ALTER TABLE `bookxStudioAssets` ADD `meanVolumeDb` int;--> statement-breakpoint
ALTER TABLE `bookxStudioAssets` ADD `peakVolumeDb` int;--> statement-breakpoint
CREATE INDEX `bookxAnalysisJobs_project_idx` ON `bookxAnalysisJobs` (`projectId`);--> statement-breakpoint
CREATE INDEX `bookxSoundCues_project_idx` ON `bookxSoundCues` (`projectId`);--> statement-breakpoint
CREATE INDEX `bookxSoundCues_chapter_idx` ON `bookxSoundCues` (`chapterId`);