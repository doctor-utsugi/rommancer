-- Device configuration: the user's RetroAchievements login and WiFi networks, kept applied on their devices,
-- and copies of each device's configuration files
ALTER TABLE `User` ADD COLUMN `raPassword` TEXT NULL,
    ADD COLUMN `raToken` TEXT NULL;

ALTER TABLE `Console` ADD COLUMN `wifiBands` VARCHAR(8) NULL;

ALTER TABLE `Device` ADD COLUMN `wifiBands` VARCHAR(8) NULL,
    ADD COLUMN `wifiBandsManual` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `keepSettings` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `settingsHash` CHAR(40) NULL,
    ADD COLUMN `settingsAt` DATETIME(3) NULL,
    ADD COLUMN `settingsError` VARCHAR(512) NULL;

CREATE TABLE `WifiNetwork` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `ssid` VARCHAR(64) NOT NULL,
    `password` TEXT NULL,
    `band` VARCHAR(8) NOT NULL DEFAULT 'dual',
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WifiNetwork_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DeviceConfigVersion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `note` VARCHAR(255) NULL,
    `files` JSON NOT NULL,
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DeviceConfigVersion_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DeviceConfigOp` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `payload` JSON NULL,
    `channel` VARCHAR(8) NULL,
    `error` VARCHAR(512) NULL,
    `versionId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `doneAt` DATETIME(3) NULL,

    INDEX `DeviceConfigOp_deviceId_status_idx`(`deviceId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WifiNetwork` ADD CONSTRAINT `WifiNetwork_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DeviceConfigVersion` ADD CONSTRAINT `DeviceConfigVersion_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DeviceConfigOp` ADD CONSTRAINT `DeviceConfigOp_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
