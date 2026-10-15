-- CreateTable
CREATE TABLE `RomIdentity` (
    `id` CHAR(40) NOT NULL,
    `platform` VARCHAR(32) NOT NULL,
    `digest` CHAR(40) NOT NULL,
    `title` VARCHAR(255) NOT NULL,

    UNIQUE INDEX `RomIdentity_platform_digest_key`(`platform`, `digest`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Journey` (
    `id` CHAR(36) NOT NULL,
    `userId` INTEGER NOT NULL,
    `identityId` CHAR(40) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `head` INTEGER NOT NULL DEFAULT 0,
    `metadata` INTEGER NOT NULL DEFAULT 0,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Journey_userId_identityId_idx`(`userId`, `identityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JourneyRevision` (
    `id` CHAR(36) NOT NULL,
    `journeyId` CHAR(36) NOT NULL,
    `number` INTEGER NOT NULL,
    `base` INTEGER NOT NULL,
    `manifest` JSON NOT NULL,
    `conflict` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JourneyRevision_journeyId_number_idx`(`journeyId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JourneyBlob` (
    `userId` INTEGER NOT NULL,
    `sha1` CHAR(40) NOT NULL,
    `size` INTEGER NOT NULL,

    PRIMARY KEY (`userId`, `sha1`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JourneyBinding` (
    `id` CHAR(36) NOT NULL,
    `deviceId` INTEGER NOT NULL,
    `identityId` CHAR(40) NOT NULL,
    `romPath` VARCHAR(1024) NOT NULL,
    `layout` JSON NOT NULL,
    `journeyId` CHAR(36) NOT NULL,
    `generation` INTEGER NOT NULL DEFAULT 0,
    `operation` CHAR(36) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `JourneyBinding_deviceId_identityId_key`(`deviceId`, `identityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JourneyCommand` (
    `id` CHAR(36) NOT NULL,
    `bindingId` CHAR(36) NOT NULL,
    `journeyId` CHAR(36) NOT NULL,
    `generation` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `error` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JourneyCommand_bindingId_status_idx`(`bindingId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Journey` ADD CONSTRAINT `Journey_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Journey` ADD CONSTRAINT `Journey_identityId_fkey` FOREIGN KEY (`identityId`) REFERENCES `RomIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JourneyRevision` ADD CONSTRAINT `JourneyRevision_journeyId_fkey` FOREIGN KEY (`journeyId`) REFERENCES `Journey`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JourneyBlob` ADD CONSTRAINT `JourneyBlob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JourneyBinding` ADD CONSTRAINT `JourneyBinding_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JourneyBinding` ADD CONSTRAINT `JourneyBinding_identityId_fkey` FOREIGN KEY (`identityId`) REFERENCES `RomIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JourneyCommand` ADD CONSTRAINT `JourneyCommand_bindingId_fkey` FOREIGN KEY (`bindingId`) REFERENCES `JourneyBinding`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

