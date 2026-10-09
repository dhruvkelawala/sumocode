#!/bin/sh
# Pi CLI entry for apps that drive `pi` themselves, such as T3 Code's Pi
# provider. Normal runs go through `sumocode --no-sumo-tui`, so the app gets the
# archive's bundled Pi with the bundled SumoCode extension and launcher env, and
# SUMOCODE_APP_HOST selects the extension's app-host profile (src/app-host.ts).
# -v/--version answers with the bundled Pi version, because those apps gate on
# Pi's version, not SumoCode's.
set -eu
export SUMOCODE_APP_HOST=1

# install.sh links this script onto PATH; follow the link back to the archive.
script="$0"
while [ -L "${script}" ]; do
	target="$(readlink "${script}")"
	case "${target}" in
		/*) script="${target}" ;;
		*) script="$(dirname -- "${script}")/${target}" ;;
	esac
done
bin_dir="$(CDPATH= cd -- "$(dirname -- "${script}")" && pwd -P)"

for arg in "$@"; do
	case "${arg}" in
		--) break ;;
		-v|--version) exec "${bin_dir}/sumocode-pi" --version ;;
		# The launcher always adds SumoCode's extension with -e, which Pi loads
		# even under --no-extensions. Apps pass that flag for helper runs (T3's
		# commit messages and titles), so honor it with bare Pi.
		--no-extensions|-ne) exec "${bin_dir}/sumocode-pi" "$@" ;;
	esac
done
exec "${bin_dir}/sumocode" --no-sumo-tui "$@"
