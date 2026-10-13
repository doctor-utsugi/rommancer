# Reference CLI over rcheevos (MIT) to validate Rommancer's RA hash in tests
RC = ../rcheevos
# Pinned: newer releases moved src/rhash and src/rc_util.c
RC_VERSION = v12.5.0
CFLAGS = -O2 -I$(RC)/include -I$(RC)/src

rahash: main.c $(RC)/include/rc_hash.h
	$(CC) $(CFLAGS) -o $@ main.c $(RC)/src/rhash/*.c $(RC)/src/rcheevos/*.c $(RC)/src/rc_compat.c $(RC)/src/rc_util.c -lm

$(RC)/include/rc_hash.h:
	git clone --depth 1 --branch $(RC_VERSION) https://github.com/RetroAchievements/rcheevos.git $(RC)

clean:
	rm -f rahash
