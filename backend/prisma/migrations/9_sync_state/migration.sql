-- AlterTable
ALTER TABLE `Device` ADD COLUMN `clockSync` BOOLEAN NULL,
    ADD COLUMN `clockSyncWant` BOOLEAN NOT NULL DEFAULT false;
