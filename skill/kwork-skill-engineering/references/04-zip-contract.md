# 技能 ZIP 契约

## 1. 可移植包的根目录规则

打包时 ZIP 根目录必须直接包含 `SKILL.md`，不能包一层技能目录：

```text
kwork-skill-engineering.zip
├── SKILL.md
├── references/
├── templates/
└── scripts/
```

在技能目录内部执行：

```bash
zip -qr ../kwork-skill-engineering.zip . -x '.DS_Store' '__MACOSX/*'
unzip -l ../kwork-skill-engineering.zip
```

`unzip -l` 的第一批条目应是 `SKILL.md` 或根目录下的资源路径，不应是 `../SKILL.md`。

## 2. SKILL.md 最小约束

- 第一行必须是 `---`，随后为 YAML frontmatter；
- `name`：小写字母、数字、连字符，且与实际技能名一致；
- `description`：非空、简明地描述适用场景；
- `whenToUse`：可选的触发说明；
- frontmatter 后必须有 Markdown 正文；
- 为多平台兼容，本包只使用扁平 `key: value` 字段，不使用嵌套、数组、工具白名单或平台元数据；
- 文件使用严格 UTF-8。

## 3. 文件类型与安全

本包仅使用附件允许的文件类型：

| 目录 | 本包使用的类型 |
|---|---|
| 根目录 | `md` |
| `references/`、`templates/` | `md` |
| `../../../灵基/scripts/` | `mjs` |

不要加入密钥、token、Cookie、环境地址、生产数据、软链接、加密压缩包或二进制缓存。脚本不会因加载技能自动执行；运行脚本前仍应先阅读其代码与参数。

## 4. 附件发布规范与当前代码的区别

用户提供的发布规范定义了面向平台的包约束，例如：ZIP 10 MiB、展开后 50 MiB、文件数 200、单文件 10 MiB、`SKILL.md` 64 KiB、路径深度/长度、20:1 压缩比，以及脚本包发布时的额外确认。

这些是**交付 ZIP 时的目标约束**。不要用 tmanage 预上传服务的内部检查替代它们：

| 场景 | 当前代码入口 | 关键语义 |
|---|---|---|
| tmanage Open 预上传 | `SkillPackageUploadService#upload` | 最大上传大小、ZIP 条目数/压缩比检查、读取 `skill.md`、流式转发文件服务器 |
| tmanage 文件转发 | `PackageStorageService#uploadZipResource` | `Resource` 交给 WebClient，避免主链把 ZIP 整包复制进堆内存 |
| kdmanage 平台导入 | `SkillAppService`、`UploadValidator` | 平台侧导入解析、结构/内容/lint 校验与发布前检查 |

因此：

- “能通过 tmanage 预上传”不等于“能通过平台发布校验”；
- “multipart 上传”不等于“所有导入路径都不使用 Base64”；
- “脚本存在”不等于“脚本会自动执行”；
- 具体限制以当前目标上传入口的代码和发布要求为准，变更前先核实。

## 5. 常见拒绝原因

- `SKILL.md` 缺失、放在外层目录、frontmatter 缺失或 `name` 不匹配；
- 非允许扩展名、图片文件头与扩展名不符；
- 路径包含 `..`、绝对路径、反斜杠、重复或大小写冲突；
- 软链接、加密归档、CRC 异常、超限文件数/大小/压缩比；
- 文本不是严格 UTF-8；
- `description` 为空或正文缺失。

先在本地查看归档清单，再从目标入口的校验日志或 lint 返回中确认真实拒绝规则。
