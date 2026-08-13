# MewCode Phase11 Spec — Hook 系统

## 背景

P1-P10 已交付完整 Agent。重复的固定动作（格式化、拦截、上下文注入）仍需人工盯——本阶段在 Agent 生命周期关键节点挂自动化动作：触发条件明确、动作固定，MewCode 自动在合适时刻执行。

## 目标

- 「事件 + 条件 + 动作」三要素声明式规则（YAML）
- 生命周期事件四层 + 系统级
- tool_before 拦截（权限裁决后）细粒度安全策略
- 四种动作 + 执行控制（once/async/timeout）

## 功能需求

- F1: 三要素规则 —— `event`（必需）+ `if`（条件，可省略=无条件）+ `action`（必需）；YAML 声明式加载 + 集中校验（缺 event/action/动作字段 → 报错跳过该规则）
- F2: 事件四层+系统级 —— 会话级（session_start / session_end）、轮次级（round_start / round_end）、消息级（message：消息产生后）、工具级（tool_before / tool_after）、系统级（app_start / app_exit）
- F3: tool_before 拦截 —— 在权限裁决**之后**运行（权限放行后 Hook 仍可拦）；条件基于工具名与参数匹配 → 命中返回拒绝 → **拒绝原因转工具结果回灌模型**（走既有 `[Hook 拦截] 原因` 通道，模型据此调整）；未命中放行
- F4: 条件语法 —— 复用权限规则匹配：精确相等、反向（`!` 前缀）、正则（`/re/`）、glob（`*`）；逻辑组合 `all`（全部满足）或 `any`（任一满足）二选一；字段：`match`（字段名）+ `pattern`
- F5: 四种动作 —— `command`（执行 shell 命令，默认 10s 超时）、`inject_prompt`（注入内容为独立 system 消息，本轮请求可见）、`http`（发 HTTP 请求，发完即弃不处理响应）、`subagent`（启动子 Agent——本阶段仅占位记录日志）
- F6: 执行控制 —— `once`（本会话只跑一次，内存标记）、`async`（后台异步执行，不阻塞 Agent 主流程）、`timeout`（命令超时，默认 10s）；**拦截类事件（tool_before）禁止 async**（校验时报错）
- F7: 失败隔离 —— Hook 自身失败（命令超时/HTTP 错误/异常）只记日志，**绝不中断 Agent 主流程**

## 非功能需求

- N1: Hook 失败不中断（try/catch 全包裹 + console.warn）
- N2: 拦截类事件同步执行（保证拦截语义）
- N3: 规则加载失败不阻断启动（坏规则跳过 + 警告）

## 不做的事

- 子 Agent 动作真实运行（SubAgent 章节对接）
- once 标记持久化（重启后 once 重置）
- Hook 执行顺序的显式优先级（按声明顺序执行）

## 验收标准

- AC1: YAML 加载与校验 —— 合法规则加载；缺 event/action 的规则跳过并警告；非法 async 拦截规则报错
- AC2: 事件触发 —— fake 驱动各事件（session_start/round_start/tool_before/tool_after/message）断言 Hook 被调
- AC3: tool_before 拦截 —— 条件命中（如 `run_command` + `command: "rm *"`）→ 工具被拦，拒绝原因回灌（模型收到 `[Hook 拦截]`）
- AC4: 条件语法 —— 精确/反向（!）/正则（/re/）/glob 各匹配用例；all/any 组合
- AC5: 四动作 —— command 执行（输出验证）；inject_prompt 注入独立 system 消息（请求断言）；http 发出（fake server 收到）；subagent 占位（日志记录）
- AC6: 执行控制 —— once 同会话不重复触发；async 不阻塞主流程（时序断言）；timeout 超时杀命令；tool_before 配 async 报错
- AC7: 失败隔离 —— command 超时/HTTP 失败/Hook 抛异常 → 主流程继续（后续事件正常触发）
- AC8: 回归 —— 全部现有测试绿

## Hook 规则格式

```yaml
hooks:
  - event: tool_before
    if:
      all:
        - match: name
          pattern: run_command
        - match: args.command
          pattern: "rm *"
    action:
      type: command
      command: 'echo "blocked rm" >> hook.log'
      async: false

  - event: round_start
    action:
      type: inject_prompt
      content: "当前轮次请优先检查测试是否通过"

  - event: session_start
    action:
      type: command
      command: 'mkdir -p .tmp'
      once: true
```
