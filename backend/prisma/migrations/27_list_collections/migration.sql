-- Whether frontends show the device's lists as collections
ALTER TABLE `Device` ADD COLUMN `listCollections` BOOLEAN NOT NULL DEFAULT true;
