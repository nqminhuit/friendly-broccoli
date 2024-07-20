#!/usr/bin/env sh

TOOLS_DIR=$HOME/tools
PODMAN_VERSION=v4.9.5

printf "Attempt to install Podman\n"

go version

storage_conf=$HOME/.config/containers/storage.conf
if [ ! -f  $storage_conf ]; then
    mkdir -p $HOME/.config/containers
    touch $storage_conf
    echo "[storage]" > $storage_conf
    echo "driver = \"overlay\"" >> $storage_conf
fi

sudo apt-get install -y make curl \
     btrfs-progs \
     iptables \
     libassuan-dev \
     libbtrfs-dev \
     libc6-dev \
     libdevmapper-dev \
     libglib2.0-dev \
     libgpgme-dev \
     libgpg-error-dev \
     libprotobuf-dev \
     libprotobuf-c-dev \
     libseccomp-dev \
     libselinux1-dev \
     libsystemd-dev \
     containernetworking-plugins \
     pkg-config \
     uidmap \
     slirp4netns \
     catatonit \
     fuse-overlayfs \
     libapparmor-dev

git clone --depth=1 https://github.com/containers/conmon $TOOLS_DIR/conmon
(cd $TOOLS_DIR/conmon; GOCACHE="$(mktemp -d)"; make; sudo make podman)
rm -rf $TOOLS_DIR/conmon

git clone --depth=1 https://github.com/opencontainers/runc.git $TOOLS_DIR/runc
(cd $TOOLS_DIR/runc; make BUILDTAGS="selinux seccomp"; sudo cp runc /usr/bin/runc)
rm -rf $TOOLS_DIR/runc

test ! -d /etc/containers && sudo mkdir -p /etc/containers # test if directory existed
test ! -f /etc/containers/registries.conf && \
    sudo curl -L -o /etc/containers/registries.conf \
         https://src.fedoraproject.org/rpms/containers-common/raw/main/f/registries.conf
test ! -f /etc/containers/policy.json && \
    sudo curl -L -o /etc/containers/policy.json \
         https://src.fedoraproject.org/rpms/containers-common/raw/main/f/default-policy.json

git clone --depth=1 -b $PODMAN_VERSION https://github.com/containers/podman.git $TOOLS_DIR/podman
cd $TOOLS_DIR/podman
make BUILDTAGS="selinux seccomp" PREFIX=/usr; sudo make install PREFIX=/usr

printf "\t$(podman --version) installed successful\n"
