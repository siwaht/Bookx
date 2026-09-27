PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bookxProjects` (
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
	`soundLevel` text DEFAULT 'extra-subtle' NOT NULL,
	`soundSource` text DEFAULT 'auto' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_bookxProjects`("id", "ownerId", "title", "author", "kind", "narrationStyle", "voiceProvider", "voiceModel", "languageModelProvider", "languageModel", "language", "manuscriptName", "manuscriptStorageKey", "coverStyle", "status", "soundEffectsEnabled", "backgroundMusicEnabled", "soundLevel", "soundSource", "createdAt", "updatedAt") SELECT "id", "ownerId", "title", "author", "kind", "narrationStyle", "voiceProvider", "voiceModel", "languageModelProvider", "languageModel", "language", "manuscriptName", "manuscriptStorageKey", "coverStyle", "status", "soundEffectsEnabled", "backgroundMusicEnabled", CASE WHEN "soundLevel" = 'very-subtle' THEN 'extra-subtle' ELSE "soundLevel" END, "soundSource", "createdAt", "updatedAt" FROM `bookxProjects`;--> statement-breakpoint
DROP TABLE `bookxProjects`;--> statement-breakpoint
ALTER TABLE `__new_bookxProjects` RENAME TO `bookxProjects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `bookxProjects_owner_idx` ON `bookxProjects` (`ownerId`);