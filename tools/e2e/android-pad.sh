#!/system/bin/sh
# pad.sh BUTTON [ms]: hold a button of the Thor's built-in controller (a=south b=east x=west y=north l r start select up down left right)
case "$1" in a) c=304;; b) c=305;; y) c=307;; x) c=308;; l) c=310;; r) c=311;; select) c=314;; start) c=315;; up) c=544;; down) c=545;; left) c=546;; right) c=547;; *) exit 1;; esac
D=/dev/input/event9
sendevent $D 1 $c 1; sendevent $D 0 0 0
sleep "$(awk "BEGIN{print ${2:-150}/1000}")" 2>/dev/null || sleep 1
sendevent $D 1 $c 0; sendevent $D 0 0 0
