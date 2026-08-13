# MewCode Spec

## 背景

从零构建一个命令行 AI 助手（Coding Agent），对标 Claude Code 的交互形态。本 spec 为第一阶段：只做「终端对话外壳 + 多 Provider 流式对话」，为后续的 tool use、文件操作、代码编辑等 Agent 功能打地基。

当前环境：Node v24.14.1（原生 TS type stripping，无需构建步骤），Windows 11，项目位于 D:\MewCode。

## 目标

- 用户在终端启动 MewCode 后进入交互式对话界面（TUI），输入问题，回复流式逐字渲染
- 支持 Anthropic Claude 与 OpenAI 两种后端，通过 YAML 配置切换
- Provider 层抽象为统一接口，新增后端只需添加一个实现文件

## 功能需求

- F1: 启动入口 —— 命令行启动 MewCode，加载配置文件，校验通过后进入对话界面
- F2: 对话界面 —— 交互式 TUI：用户输入框 + 回复渲染区，回复以流式逐字方式出现（边接收边渲染，不等全部生成）
- F3: 多轮对话 —— 同一会话内多次提问，每次请求携带完整对话历史，AI 能引用之前的内容
- F4: 配置加载 —— YAML 配置文件，六字段：name（标识名）、protocol（协议选择）、model、base_url、api_key、thinking（是否启用扩展思考，可选，默认关闭）；配置缺失/格式错误时给出明确错误提示
- F5: Provider 抽象层 —— 统一接口定义对话与流式能力，Anthropic 与 OpenAI 各自实现，运行时按配置的 protocol 选择实现
- F6: Anthropic 后端 —— 通过 SSE 流式接收回复；thinking 开启时支持 Claude extended thinking 的流式接收
- F7: OpenAI 后端 —— 通过 SSE 流式接收回复

## 非功能需求

- N1: 流式低延迟 —— 收到首个 token 即开始渲染，不等待完整响应
- N2: 退出处理 —— Ctrl+C 干净退出，不残留半截渲染状态
- N3: 密钥安全 —— api_key 仅存于本地配置文件，不写入日志、不打印
- N4: 零构建 —— Node 24 原生运行 TypeScript，无需编译步骤即可启动

## 不做的事

- Tool use / 函数调用
- 文件操作、代码编辑、命令执行
- 子代理 / 多 Agent 编排
- 上下文摘要压缩与窗口截断（采用全历史发送）
- 除 Anthropic / OpenAI 外的其他后端
- 会话持久化、历史导出、断点恢复
- 打包分发（exe/二进制）

## 验收标准

- AC1: 运行启动命令后出现对话界面，可输入、可回车发送
- AC2: 配置为 Anthropic 后端时，提问收到流式回复，文字逐字出现而非整段闪现
- AC3: 配置为 OpenAI 后端时，同样可流式对话
- AC4: 多轮对话：先告知一个事实（如「我叫小明」），下一轮提问引用它，AI 能正确回答
- AC5: thinking 开启时，Claude 回复包含思考过程且完整呈现
- AC6: 配置缺少 api_key 或 protocol 非法时，启动即报清晰错误并说明原因
- AC7: 对话中按 Ctrl+C，界面干净退出，无报错堆栈
