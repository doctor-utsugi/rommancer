-- CreateTable
CREATE TABLE `DeviceLink` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(16) NOT NULL,
    `secretHash` CHAR(64) NOT NULL,
    `deviceName` VARCHAR(128) NOT NULL,
    `firmwareHint` VARCHAR(64) NULL,
    `rootHint` VARCHAR(512) NULL,
    `model` VARCHAR(128) NULL,
    `overrides` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `approvedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `userId` INTEGER NULL,
    `deviceId` INTEGER NULL,
    `tokenEnc` TEXT NULL,

    UNIQUE INDEX `DeviceLink_code_key`(`code`),
    UNIQUE INDEX `DeviceLink_secretHash_key`(`secretHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeviceLink` ADD CONSTRAINT `DeviceLink_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

