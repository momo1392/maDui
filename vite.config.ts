import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 通过环境变量控制 base，方便 GitHub Pages 子路径部署
// - 自定义域名 / user.github.io 仓库：BASE 不设或设为 "/"
// - username.github.io/<repo>/：构建时 BASE=/repo/
const base = process.env.BASE || '/';

export default defineConfig({
  base,
  plugins: [vue()],
  server: { host: true, port: 5173 }
});
