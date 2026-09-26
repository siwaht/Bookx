ALTER TABLE `bookxProviderSettings` MODIFY COLUMN `provider` varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `defaultTtsModel` varchar(160);--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `defaultSttModel` varchar(160);--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `defaultLlmModel` varchar(160);--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `fallbackProvider` varchar(80);--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `fallbackEnabled` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookxProviderSettings` ADD `apiBaseUrl` varchar(255);