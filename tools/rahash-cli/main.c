/*
 * Minimal CLI over rcheevos (rc_hash) to validate Rommancer's RetroAchievements hash.
 * Usage: rahash <console_id> <file>
 * Build: make -C tools/rahash-cli
 */
#include <stdio.h>
#include <stdlib.h>
#include "rc_hash.h"

int main(int argc, char** argv)
{
  char hash[33];
  if (argc != 3) {
    fprintf(stderr, "usage: %s <console_id> <file>\n", argv[0]);
    return 2;
  }
  if (!rc_hash_generate_from_file(hash, (uint32_t)atoi(argv[1]), argv[2]))
    return 1;
  printf("%s\n", hash);
  return 0;
}
