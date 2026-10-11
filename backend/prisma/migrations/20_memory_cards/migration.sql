-- Memory cards: saves inside a card synced entry by entry, the user's cards, card files on devices and their snapshots
-- AlterTable
ALTER TABLE `Save` ADD COLUMN `cardId` INTEGER NULL,
    ADD COLUMN `label` VARCHAR(128) NULL,
    ADD COLUMN `supersededAt` DATETIME(3) NULL,
    MODIFY `kind` ENUM('SAVE', 'STATE', 'ENTRY') NOT NULL;

-- CreateTable
CREATE TABLE `MemoryCard` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `family` VARCHAR(16) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MemoryCard_userId_family_name_key`(`userId`, `family`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeviceCard` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `emulatorId` INTEGER NOT NULL,
    `shared` BOOLEAN NOT NULL DEFAULT false,
    `gameId` INTEGER NULL,
    `cardId` INTEGER NOT NULL,
    `lastSha1` CHAR(40) NULL,
    `offerSha1` CHAR(40) NULL,
    `offer` JSON NULL,
    `freeBlocks` INTEGER NULL,
    `warning` VARCHAR(512) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeviceCard_deviceId_path_key`(`deviceId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CardEntryBase` (
    `deviceCardId` INTEGER NOT NULL,
    `saveId` INTEGER NOT NULL,
    `versionId` INTEGER NULL,
    `entrySha1` CHAR(40) NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`deviceCardId`, `saveId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CardSnapshot` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceCardId` INTEGER NOT NULL,
    `sha1` CHAR(40) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `size` INTEGER NOT NULL,
    `kind` VARCHAR(8) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CardSnapshot_deviceCardId_idx`(`deviceCardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Save_cardId_baseName_key` ON `Save`(`cardId`, `baseName`);

-- AddForeignKey
ALTER TABLE `Save` ADD CONSTRAINT `Save_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `MemoryCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MemoryCard` ADD CONSTRAINT `MemoryCard_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceCard` ADD CONSTRAINT `DeviceCard_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceCard` ADD CONSTRAINT `DeviceCard_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `MemoryCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceCard` ADD CONSTRAINT `DeviceCard_emulatorId_fkey` FOREIGN KEY (`emulatorId`) REFERENCES `Emulator`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CardEntryBase` ADD CONSTRAINT `CardEntryBase_deviceCardId_fkey` FOREIGN KEY (`deviceCardId`) REFERENCES `DeviceCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CardEntryBase` ADD CONSTRAINT `CardEntryBase_saveId_fkey` FOREIGN KEY (`saveId`) REFERENCES `Save`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CardSnapshot` ADD CONSTRAINT `CardSnapshot_deviceCardId_fkey` FOREIGN KEY (`deviceCardId`) REFERENCES `DeviceCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

