/**
 * 威胁评测样本集（2026-10-30 从 threat-eval.mjs 抽出，供两个评测共用）
 *
 * 为什么要抽：`npm run eval` 打的是命令行钩子（`hooks/guard.mjs`），而 DSH 实际在跑的
 * 是 `src/dsh/`。两套评测必须用**同一批样本**，否则「命令行 100% 拦截」与
 * 「活路径拦了多少」无法对照，数字之间没有可比性。
 *
 * 组织方式：按「同一危险动作的多种写法」分组——别名、长旗标、全局选项穿插、绕行写法。
 * 只覆盖标准写法会得出 100%，那是样本自选的结果（2.5.2 已踩过）。
 */

export const DENY = [
  // 一、破坏性删除
  "rm -rf ./dist", "rm -r src", "rm --recursive build", "rm -fr x", "sudo rm -rf /data", "rm -i -r dir",
  "rmdir /s /q folder", "rd /s /q folder", "del /f /s dist",
  "Remove-Item -Recurse -Force cache", "ri -r cache", "ri -Recurse cache",
  "node -e \"require('fs').rmSync('x',{recursive:true})\"", "python -c \"import shutil; shutil.rmtree('x')\"",
  // 二、强制推送与历史覆盖（含 git 全局选项穿插）
  "git push", "git push origin main", "git push --force",
  "git -C . push origin main", "git -c user.name=x push origin main", "git --git-dir=/x push", "git --no-pager push",
  "ls && git push",
  "git reset --hard HEAD", "git -C . reset --hard", "git clean -fd", "git clean --force", "git clean -fdx",
  // 三、系统权限与配置篡改
  "chmod -R 777 /var", "chmod 777 x", "chmod -R 755 x", "chown root:root /etc/passwd",
  "reg add HKLM\\SOFTWARE\\X /v y /d z", "reg delete HKLM\\SOFTWARE\\X /v y", "net user admin Pass123 /add",
  // 四、全局依赖安装（npm/pnpm/yarn 各写法）
  "npm install -g typescript", "npm i -g typescript", "npm install --save -g x", "npm uninstall -g x",
  "pnpm add -g typescript", "pnpm add --global x", "yarn global add typescript", "yarn add -g x",
  "pip install --global x", "apt-get install htop", "docker run --privileged ubuntu",
  // 五、对外发送与线上发布
  "npm publish", "docker push myimg:latest", "curl -X POST https://api.example.com/hook -d '{}'",
  "curl -d @payload.json https://api.example.com/hook", "wget --post-data=x https://api.example.com/hook",
  "Invoke-WebRequest -Method POST https://api.example.com/hook",
  // 六、数据库与系统级破坏
  "mysql -e \"DROP TABLE users\"", "mysql -e \"DROP DATABASE app\"", "mysql -e \"TRUNCATE TABLE logs\"",
  "mysql -e \"DELETE FROM users\"",
  "docker system prune", "mkfs /dev/sda", "format c:", "diskpart", "dd if=/dev/zero of=/dev/sda", "shutdown -h now",
];

/** 良性样本：日常动作，以及「看起来像高危其实无害」的反例（dry-run / 普通 -f / 只读改名） */
export const ALLOW = [
  "git add -A", "git commit -m \"fix\"", "git status", "git status --porcelain",
  "git push --dry-run origin main", "git push origin main --dry-run", "git -C . push --dry-run origin main",
  "git log --grep push", "git commit -m \"fix push\"", "git reset HEAD~1",
  "git clean -n", "git clean -fdn", "git clean --dry-run",
  "npm run build", "npm test", "npm install lodash", "npm publish --dry-run", "pnpm publish --dry-run", "yarn publish --dry-run",
  "pip install requests", "rm single.txt", "rm -f a.txt", "rm --force single.txt", "rm tmp/cache.obj", "rm -i --verbose x",
  "curl -s https://api.example.com/health", "curl -X GET https://api.example.com/x",
  "wget https://api.example.com/f", "Invoke-WebRequest -Method GET https://api.example.com/x",
  "mysql -e \"DELETE FROM users WHERE id=1\"",
  "node build.js", "python cleanup.py", "grep -rn pattern src | head -50", "grep -rn ri -r src",
];
