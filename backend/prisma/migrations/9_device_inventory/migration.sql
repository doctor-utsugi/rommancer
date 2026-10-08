-- AlterTable
ALTER TABLE `Device` ADD COLUMN `allowPull` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `inventoryAt` DATETIME(3) NULL,
    ADD COLUMN `wantSyncAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `DeviceRom` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `pathHash` CHAR(40) NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `systemSlug` VARCHAR(32) NULL,
    `size` BIGINT NOT NULL DEFAULT 0,
    `sha1` CHAR(40) NULL,
    `headerlessSha1` CHAR(40) NULL,
    `romId` INTEGER NULL,
    `gameId` INTEGER NULL,

    INDEX `DeviceRom_gameId_idx`(`gameId`),
    INDEX `DeviceRom_romId_idx`(`romId`),
    UNIQUE INDEX `DeviceRom_deviceId_pathHash_key`(`deviceId`, `pathHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DevicePull` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `path` VARCHAR(1024) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `result` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `doneAt` DATETIME(3) NULL,

    INDEX `DevicePull_deviceId_status_idx`(`deviceId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeviceRom` ADD CONSTRAINT `DeviceRom_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DevicePull` ADD CONSTRAINT `DevicePull_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

