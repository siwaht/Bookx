CREATE TABLE `bookxStudioAssets` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`type` enum('music','sound-effect','recording') NOT NULL,
	`title` varchar(255) NOT NULL,
	`storageKey` varchar(512),
	`durationMs` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxStudioAssets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bookxTimelineClips` (
	`id` varchar(32) NOT NULL,
	`projectId` varchar(32) NOT NULL,
	`assetId` varchar(32),
	`segmentId` varchar(32),
	`trackType` enum('narration','music','sound-effect') NOT NULL,
	`startMs` int NOT NULL DEFAULT 0,
	`durationMs` int NOT NULL DEFAULT 0,
	`volume` int NOT NULL DEFAULT 80,
	`fadeInMs` int NOT NULL DEFAULT 0,
	`fadeOutMs` int NOT NULL DEFAULT 0,
	`duckUnderNarration` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bookxTimelineClips_id` PRIMARY KEY(`id`)
);
