ALTER TABLE `bookxCharacters` ADD `voiceRationale` varchar(512);--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `sampleLine` text;--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `assignmentConfidence` int;--> statement-breakpoint
ALTER TABLE `bookxCharacters` ADD `assignmentSource` enum('manual','llm') DEFAULT 'manual' NOT NULL;