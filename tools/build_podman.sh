#!/usr/bin/env sh

TOOLS_DIR=$HOME/tools
PODMAN_VERSION=$1

printf "Attempt to install Podman\n"

go version

git clone --depth=1 -b $PODMAN_VERSION https://github.com/containers/podman.git $TOOLS_DIR/podman
cd $TOOLS_DIR/podman
make BUILDTAGS="selinux seccomp" PREFIX=/usr; sudo make install PREFIX=/usr

printf "\t$(podman --version) installed successful\n"
