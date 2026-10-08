-- Favourite roms per user, and each user's RetroAchievements progress
ALTER TABLE `User` ADD COLUMN `raProfile` JSON NULL,
    ADD COLUMN `raProgressAt` DATETIME(3) NULL;

CREATE TABLE `RomFavorite` (
    `userId` INTEGER NOT NULL,
    `romId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RomFavorite_romId_idx`(`romId`),
    PRIMARY KEY (`userId`, `romId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RaUserProgress` (
    `userId` INTEGER NOT NULL,
    `raGameId` INTEGER NOT NULL,
    `awarded` INTEGER NOT NULL DEFAULT 0,
    `awardedHardcore` INTEGER NOT NULL DEFAULT 0,
    `total` INTEGER NOT NULL DEFAULT 0,
    `lastAt` DATETIME(3) NULL,

    PRIMARY KEY (`userId`, `raGameId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RomFavorite` ADD CONSTRAINT `RomFavorite_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `RomFavorite` ADD CONSTRAINT `RomFavorite_romId_fkey` FOREIGN KEY (`romId`) REFERENCES `Rom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `RaUserProgress` ADD CONSTRAINT `RaUserProgress_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
