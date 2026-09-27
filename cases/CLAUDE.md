# cases/
> L2 | 父级: ../CLAUDE.md

成员清单
gemini-case-1482-key-typo.json: 键名 typo（id 写成 id/）叠加 `*```json` 前缀的畸形回包夹具，10 条，含 ruby 字符串字段
gemini-case-1547-trailing-5.json: 数组与闭合大括号之间插入杂质字符 `]5}` 的 JSON 损坏夹具，3 条，使用 readings 字典
gemini-case-1585-request-8.json: 网关直接把 content 作为已解析对象返回的夹具，5 条，覆盖 readings 为空的边缘情况

设计边界:
每个夹具是一个 provider 畸形回包的结构快照，由 `scripts/translation-worker.test.mjs` 全量读取并驱动真实 service_worker 解析。夹具的价值在于**结构畸形**——键名 typo、尾部杂质、content 类型差异、空 readings——而非字幕文本本身；因此文本一律使用合成内容，禁止提交影视作品对白或任何第三方的版权文本。新增夹具必须保留其针对的畸形，并同步 `expectedItems` 的 id 与数量。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
