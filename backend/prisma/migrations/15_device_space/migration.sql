-- Device free space (reported by its client), the reserve kept on it, and what did not fit last time
ALTER TABLE `Device` ADD COLUMN `reservePercent` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `spaceFree` BIGINT NULL,
    ADD COLUMN `spaceTotal` BIGINT NULL,
    ADD COLUMN `spaceAt` DATETIME(3) NULL,
    ADD COLUMN `spaceShortfall` JSON NULL;
