#!/bin/bash
# Phase 1 + 3: Node via nvm, clone njsPC, npm install. Runs detached on the Zero.
echo "=== nvm install ==="
export NVM_DIR="$HOME/.nvm"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
echo "=== node install ==="
nvm install --lts
nvm alias default 'lts/*'
echo "node: $(node --version 2>&1)"
echo "npm: $(npm --version 2>&1)"
echo "=== clone njsPC ==="
cd "$HOME"
if [ ! -d nodejs-poolController ]; then
  git clone https://github.com/tagyoureit/nodejs-poolController.git
fi
cd nodejs-poolController
echo "=== npm install ==="
npm install
echo "NPM_EXIT=$?"
echo INSTALL_DONE
