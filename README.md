# NAI 中转

把生图请求统一从服务器发往 NovelAI。用户各自持有中转 key，真正的 NAI Token 只保存在服务器上。

- 统一出口 IP、统一请求头（不转发客户端的 IP / UA / Cookie）
- 全局串行队列：同一时间只跑一个生成，两次生成之间留随机间隔，避免并发 429
- 接口白名单：只放行生图和只读的账号信息接口
- 流式生图（`generate-image-stream`）原样透传
- JSON 行格式日志，按天切割
- 自带网页端：打开 `https://你的域名/` 用中转 key 登录即可，同时兼容第三方工具

## 部署

服务器需要能直接访问 novelai.net，并且 80/443 端口空闲。

```bash
# 1. 拉代码
git clone https://github.com/Ayasesaki7/nai-relay.git
cd nai-relay

# 2. 配置：填 DOMAIN、NAI_TOKEN、PROXY_KEYS
cp .env.example .env
vim .env

# 3. 启动（域名要先解析到服务器，Caddy 会自动申请证书）
docker compose up -d --build

# 4. 验证
curl https://你的域名/healthz
docker compose logs -f nai-proxy     # 看到 startup 那行、没有报错就行
```

浏览器打开 `https://你的域名/`，用 `PROXY_KEYS` 里某个用户名后面的 key 登录。

加人或换 key：改 `PROXY_KEYS`（`openssl rand -hex 24` 生成，前面加 `sk-`），然后 `docker compose up -d`。

**NAI Token**：官网 → Account Settings → Get Persistent API Token，`pst-` 开头。它能操作你的账号，只放在服务器的 `.env` 里，不要提交到 Git，也不要发给其他用户。

### 如果服务器上已经有 nginx

删掉 `docker-compose.yml` 里的 `caddy` 服务，把 `nai-proxy` 的 `expose` 改成 `ports: ["127.0.0.1:8000:8000"]`，然后在 nginx 里加：

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖，不要用 $proxy_add_x_forwarded_for
    proxy_buffering off;                              # 流式生图需要
    proxy_read_timeout 300s;
    client_max_body_size 50m;
}
```

## 网页端

浏览器打开 `https://你的域名/`，输入自己的中转 key。支持：

- 文生图（V4.5 / V5，Full / Curated）、多角色及位置、负面预设、质量词
- 角色参考、氛围迁移（编码结果缓存在浏览器，同一张图不重复扣费）
- 图生图、画蒙版局部重绘
- 放大、导演工具（去背景、线稿、素描、上色、改表情、去杂物）
- 提示词补全、生成费用估算、Anlas / V5 额度显示、队列状态
- 历史记录：保存在**各自浏览器**里（IndexedDB），不会上传到服务器，换浏览器看不到
- 把 NAI 生成的 PNG 拖进页面可以读取参数，其他图片会设为底图；`Ctrl+Enter` 生成，`←` `→` 翻看

## 第三方工具

第三方工具里：

| 配置项 | 填写 |
|---|---|
| API 地址 / Image 地址 / Base URL | `https://你的域名`（两个地址都填这个） |
| Token | 你的中转 key（不是 NAI 的 pst token） |

服务按路径自动分发：`/ai/*` 和 `/user/*` → `image.novelai.net`，`/ai/upscale`、`/ai/annotate-image` → `api.novelai.net`。
`/proxy/me` 返回当前 key 对应的用户名和队列状态（网页端用来显示"排队中"）。
不要使用工具里"用户名 + 密码登录"的方式，只用 Token。

## 日志

```bash
docker compose logs -f nai-proxy          # 实时
tail -f logs/proxy.log                    # 文件，按天切割，默认保留 30 天
grep '"user":"alice"' logs/proxy.log      # 按人筛选
grep '"status":4' logs/proxy.log          # 看出错的请求（会附带 NAI 返回的错误信息）
```

每行一条 JSON，`evt` 字段说明事件类型：

| evt | 含义 |
|---|---|
| `request` | 一次转发。`wait` 排队秒数，`dur` 总耗时，`ahead` 前面排了几个，`aborted` 客户端中途断开 |
| `auth_fail` | key 错误 |
| `blocked` | 请求了白名单之外的接口 |
| `queue_timeout` | 排队超过 `QUEUE_TIMEOUT` |
| `upstream_error` | 连不上 NAI |

默认不记录提示词，需要的话在 `.env` 里设置 `LOG_PROMPT=true`。

## 维护

```bash
docker compose up -d --build     # 改了代码、网页或 .env 之后（restart 不会重新读取 .env）
```

需要放行新接口时，改 `app/main.py` 里的 `ROUTES`。

## 声明

本项目是非官方工具，与 Anlatan / NovelAI 没有关联。使用前请自行确认符合 NovelAI 的服务条款，账号风险由使用者自行承担。

## 许可证

[MIT](LICENSE)
