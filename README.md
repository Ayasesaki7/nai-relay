# NAI 中转

把生图请求统一从服务器发往 NovelAI。用户各自持有中转 key，真正的 NAI Token 只保存在服务器上。

- 统一出口 IP、统一请求头（不转发客户端的 IP / UA / Cookie）
- 全局串行队列：同一时间只跑一个生成，两次生成之间留随机间隔，避免并发 429
- 接口白名单：只放行生图和只读的账号信息接口
- 流式生图（`generate-image-stream`）原样透传
- JSON 行格式日志，按天切割
- 自带网页端：打开 `https://你的域名/` 用中转 key 登录即可，同时兼容第三方工具

## 部署

服务器需要能直接访问 novelai.net。下面的步骤使用自带的 Caddy，需要 80/443 端口空闲；如果服务器已有反向代理，请看[如果服务器上已经有 nginx](#如果服务器上已经有-nginx)。

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

管理入口：`https://你的域名/manage`。首次启动时，`me` 的中转 Key 为管理 Key（没有 `me` 时使用第一条），其余用户为普通用户；用管理 Key 登录生图页后也会显示“管理”链接。

面板支持验证并更换官方 PST、查询官方额度，以及创建、改名、复制、停用/启用、轮换和删除普通用户的中转 Key。新 Key 默认自动生成，也可填写至少 10 位的自定义 Key。管理 Key 保留，不能在面板中停用、删除或轮换。

首次启动从 `.env` 初始化，之后以 `data/control.json` 为准，修改立即生效，重启后保留。请持久化整个 `data/` 目录并保密备份；不要把它提交 Git。官方 PST 不会回显，只有管理员显式查看用户 Key 时才返回完整中转 Key。旧版升级请给容器增加 `./data:/app/data` 挂载。

**NAI Token**：官网 → Account Settings → Get Persistent API Token，`pst-` 开头。它能操作你的账号，只放在服务器的私密配置中，不要提交到 Git，也不要发给其他用户。

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
- TAG 检索（`Ctrl+K`）：用中文或英文查 Danbooru TAG，看中文意思、分类、热度、别名和相关 TAG，一键加到正面 / 负面 / 某个角色；输入中文时补全会给出对应的英文 TAG
- 标签模式：提示词显示成一个个词块，可拖动排序、调权重（`1.2::tag::`，也认 `{}` `[]`）、`//` 临时停用、撤销重做
- 个人词库：收藏 TAG 和提示词组合并分类，固定词一键套用 / 撤下，`__分类名__` 生成时从该分类随机抽一条；支持搜索、批量整理、导入导出 JSON
- 提示词快照：保存 / 恢复整套提示词、负面、角色和质量词设置
- 词库和快照按中转 key **存在服务器**的 `data/users/` 下，换设备也能用，每个人只能读写自己的
- 历史记录：保存在**各自浏览器**里（IndexedDB），不会上传到服务器，换浏览器看不到
- 云端图库：在查看器点「收藏」或在历史里多选后收藏，原图连同生成参数存到服务器的 `data/users/<id>/gallery/`，换电脑、手机也能看到；支持相册、按提示词搜索、批量移动 / 下载 / 删除，以及从收藏的图「取回参数」（勾选要用的提示词、负面、角色、尺寸参数、种子）。同一张图只存一份，每人默认 5 GB，可用 `.env` 的 `GALLERY_QUOTA_MB` 调整
- 参考素材库：氛围参考和角色参考图存到服务器的 `data/users/<id>/assets/`，按分类整理、搜索、批量移动 / 导出 / 删除，点一下就用于当前生图；氛围参考编码一次后编码也存在服务器，换设备再用不用再花 Anlas。支持导入导出 `.naiv4vibe` / `.naiv4vibebundle`（按官网格式尽量兼容）和本站的 `.json`。每人默认 1 GB，可用 `.env` 的 `ASSET_QUOTA_MB` 调整
- 灵感画廊：在 Danbooru / Safebooru（配了 key 还有 Gelbooru）上按 TAG 找图，支持最新 / 热门（日、周、月）/ 随机 / 高分和分级筛选，搜索框可以直接打中文（会用词典换成英文 TAG）。点开一张图能看到分组的 TAG 和中文意思，勾选后一键加到提示词或复制；「带回生图」会下载原图，图里有 NAI 参数就能直接读取，没有也能当底图 / 角色参考 / 氛围参考。喜欢的图可以收藏，收藏存在服务器上、每人各一份。列表和图片都由服务器代取，图片代理只放行这几个站的域名
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

中文词库来自 [ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table)（MIT），服务启动后自动下载到 `data/` 并每天更新；别名和相关 TAG 由服务器向 Danbooru 实时查询。
