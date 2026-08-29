#!/bin/bash
# Phase 4 + 5: install dashPanel, put njsPC + dashPanel under PM2, pm2 save.
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"

echo "=== clone dashPanel ==="
cd "$HOME"
if [ ! -d nodejs-poolController-dashPanel ]; then
  git clone https://github.com/rstrouse/nodejs-poolController-dashPanel.git
fi
cd nodejs-poolController-dashPanel
echo "=== npm install dashPanel ==="
npm install
echo "DASHPANEL_NPM_EXIT=$?"

echo "=== install pm2 ==="
npm install -g pm2
echo "PM2_NPM_EXIT=$?"

echo "=== stop manual njsPC ==="
pkill -f 'node dist/app.js' 2>/dev/null
sleep 2

echo "=== pm2 start both ==="
cd "$HOME/nodejs-poolController"
pm2 start npm --name njsPC -- start
cd "$HOME/nodejs-poolController-dashPanel"
pm2 start npm --name dashPanel -- start
pm2 save
echo "PM2_SAVE_EXIT=$?"
pm2 ls
echo SETUP_DONE
