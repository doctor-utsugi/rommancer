-- AlterTable
ALTER TABLE `DeviceRom` ADD COLUMN `serial` VARCHAR(64) NULL,
    ADD COLUMN `baseGameId` INTEGER NULL;

-- CreateTable
CREATE TABLE `DeviceProbe` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `pathHash` CHAR(40) NOT NULL,
    `size` BIGINT NOT NULL DEFAULT 0,
    `platform` VARCHAR(16) NULL,
    `serial` VARCHAR(64) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DeviceProbe_deviceId_pathHash_key`(`deviceId`, `pathHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeviceProbe` ADD CONSTRAINT `DeviceProbe_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
