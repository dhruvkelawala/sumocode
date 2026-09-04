#!/bin/sh
set -eu

usage() {
	printf '%s\n' "usage: install.sh [sumocode-<version>-<platform>.tar.gz]"
	printf '%s\n' "       SUMOCODE_INSTALL_PREFIX=~/.local install.sh [...]"
}

case "${1-}" in
	-h|--help) usage; exit 0 ;;
	"") archive="" ;;
	*) archive="$1" ;;
esac

prefix="${SUMOCODE_INSTALL_PREFIX:-${HOME}/.local}"
temporary=""
cleanup() {
	if [ -n "${temporary}" ]; then rm -rf "${temporary}"; fi
}
trap cleanup EXIT INT TERM

if [ -n "${archive}" ]; then
	[ -f "${archive}" ] || { printf >&2 '[sumocode] archive not found: %s\n' "${archive}"; exit 64; }
	temporary="$(mktemp -d "${TMPDIR:-/tmp}/sumocode-install.XXXXXX")"
	tar -xzf "${archive}" -C "${temporary}"
	set -- "${temporary}"/sumocode-*
	[ "$#" -eq 1 ] && [ -d "$1" ] || { printf >&2 '%s\n' '[sumocode] archive must contain one sumocode-<version>-<platform> directory'; exit 65; }
	source_root="$1"
else
	source_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
fi

for required in bin/sumocode bin/sumocode-pi extension/sumocode-extension.bundle.mjs extension/sumocode-rpc-extension.bundle.mjs share/yoga.wasm share/sumo-face.ans; do
	[ -f "${source_root}/${required}" ] || { printf >&2 '[sumocode] incomplete release: missing %s\n' "${required}"; exit 65; }
done
[ -x "${source_root}/bin/sumocode" ] || { printf >&2 '%s\n' '[sumocode] bin/sumocode is not executable'; exit 65; }

release="$(basename -- "${source_root}")"
destination="${prefix}/lib/sumocode/${release}"
mkdir -p "${destination}" "${prefix}/bin"
cp -R "${source_root}/." "${destination}/"
ln -sfn "${destination}/bin/sumocode" "${prefix}/bin/sumocode"

printf '[sumocode] installed %s\n' "${destination}"
printf '[sumocode] linked %s -> %s\n' "${prefix}/bin/sumocode" "${destination}/bin/sumocode"
case ":${PATH}:" in
	*":${prefix}/bin:"*) ;;
	*) printf '[sumocode] add %s/bin to PATH\n' "${prefix}" ;;
esac
printf '%s\n' '[sumocode] macOS Gatekeeper: if the downloaded binary is quarantined, run:'
printf '  xattr -dr com.apple.quarantine %s\n' "${destination}"
