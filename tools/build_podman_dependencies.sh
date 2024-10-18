#!/usr/bin/env sh

TOOLS_DIR=$HOME/tools

go version

# storage_conf=$HOME/.config/containers/storage.conf
# if [ ! -f  $storage_conf ]; then
#     mkdir -p $HOME/.config/containers
#     touch $storage_conf
#     echo "[storage]" > $storage_conf
#     echo "driver = \"overlay\"" >> $storage_conf
# fi

git clone --depth=1 https://github.com/containers/conmon $TOOLS_DIR/conmon
(cd $TOOLS_DIR/conmon; GOCACHE="$(mktemp -d)"; make; sudo make podman)
rm -rf $TOOLS_DIR/conmon

git clone --depth=1 https://github.com/opencontainers/runc.git $TOOLS_DIR/runc
(cd $TOOLS_DIR/runc; make BUILDTAGS="selinux seccomp"; sudo cp runc /usr/bin/runc)
rm -rf $TOOLS_DIR/runc

# test ! -d /etc/containers && sudo mkdir -p /etc/containers # test if directory existed
# test ! -f /etc/containers/registries.conf && \
#     sudo curl -L -o /etc/containers/registries.conf \
#          https://raw.githubusercontent.com/containers/image/main/registries.conf
# test ! -f /etc/containers/policy.json && \
#     sudo curl -L -o /etc/containers/policy.json \
#          https://raw.githubusercontent.com/containers/image/main/default-policy.json
