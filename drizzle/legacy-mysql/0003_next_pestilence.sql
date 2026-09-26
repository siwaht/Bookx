ALTER TABLE `bookxProjects` ADD `voiceProvider` varchar(80) DEFAULT 'ElevenLabs' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `languageModelProvider` varchar(80) DEFAULT 'Cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProjects` ADD `languageModel` varchar(160) DEFAULT '@cf/openai/gpt-oss-120b' NOT NULL;