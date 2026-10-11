-- AlterTable
ALTER TABLE `Device` ADD COLUMN `pruneRoms` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `pruneRemote` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `pruneHeld` INTEGER NULL,
    ADD COLUMN `pruneAllow` INTEGER NULL;
