CREATE TABLE `bookxUsageEvents` (
	`id` text PRIMARY KEY NOT NULL,
	`ownerId` integer NOT NULL,
	`projectId` text,
	`provider` text NOT NULL,
	`capability` text NOT NULL,
	`model` text,
	`purpose` text,
	`characters` integer DEFAULT 0 NOT NULL,
	`inputTokens` integer DEFAULT 0 NOT NULL,
	`outputTokens` integer DEFAULT 0 NOT NULL,
	`audioMs` integer DEFAULT 0 NOT NULL,
	`providerCost` real,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bookxUsageEvents_owner_idx` ON `bookxUsageEvents` (`ownerId`,`provider`,`createdAt`);--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `direction` text;--> statement-breakpoint
ALTER TABLE `bookxChapters` ADD `soundOptions` text;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `soundOptions` text;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `voiceSettings` text;--> statement-breakpoint
ALTER TABLE `bookxSegments` ADD `directionHash` text;--> statement-breakpoint
ALTER TABLE `bookxSoundCues` ADD `offsetMs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxSoundCues` ADD `lengthMs` integer;