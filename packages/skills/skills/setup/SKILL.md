---
name: setup
description: 初始化：管理员接入新的飞书多维表格 CRM 时使用，读取表结构，识别客户、商机、联系人、跟进、待办表与字段，产出 mapping.yaml 草稿和需要人工确认的字段清单。
command: /初始化
allowed_tools: [schema_inspect]
roles: [admin]
---

# 初始化字段映射

帮管理员把客户现有的多维表格 CRM 映射到开单的标准对象模型。你只出草稿，不改任何配置。

## 何时使用

- 管理员输入 /初始化，准备接入一份新的多维表格。
- 客户调整了表结构（新增 / 改名字段），需要重新生成映射。
- 只有管理员可以使用；其他角色会被拒绝。

## 步骤

1. 调用 `schema_inspect`，拿到所有数据表及字段（名称、类型、单选选项）。
2. **识别表**：按表名和字段判断对象类型——
   - account（客户）：客户名称、行业、地区、等级；
   - opportunity（商机）：商机名称、阶段、金额、预计成交日期、关联客户；
   - contact（联系人）：姓名、职务、电话、关联客户；
   - activity（跟进）：跟进方式、主题、内容、跟进时间；
   - task（待办）：标题、截止日期、状态。
   account 与 opportunity 必须找到；其余找不到就省略并在清单里说明。
3. **识别字段**：把 ROM 字段名映射到表字段名。常用 ROM 字段：name、ownerId（负责人，人员字段）、accountId / opportunityId（关联字段）、stage、amount、expectedCloseDate、probability、nextStep、lastActivityAt、title、role、phone（电话，只会以脱敏形式读取）、email、kind、subject、summary、occurredAt、dueDate、status。
4. **阶段映射**：把商机表"阶段"单选的每个选项映射到 lead / qualified / solution / negotiation / won / lost，写进 stageMap。
5. **资格字段**：如果有痛点、决策人、预算、时间线类字段，在清单里注明它们对应 pain / decision_maker / budget / timeline。
6. 把没把握的地方全部列入"需要人工确认"。

## 输出格式

1. 一句话概述：识别到几张表、分别对应什么对象。
2. mapping.yaml 草稿，放在 yaml 代码块中，结构如下：

```yaml
version: 1
objects:
  account:
    tableId: tbl_xxx
    fields: { name: 客户名称, ownerId: 负责人 }
  opportunity:
    tableId: tbl_yyy
    fields: { name: 商机名称, accountId: 客户, stage: 阶段, amount: 金额 }
    stageMap: { 初步接洽: lead, 方案报价: solution, 赢单: won }
```

3. **需要人工确认的字段**：表格或列表，每条写"表 / 字段 / 猜测的映射 / 不确定的原因"。
4. 末尾固定一句："这是草稿，不会自动生效；请管理员核对后保存为 mapping.yaml 并在配置中引用。"

## 写入规则

- 本技能不写 CRM，也不修改任何配置文件；草稿不会自动生效。
- tableId 与字段名必须与工具返回的原文完全一致，不要翻译或改写。

## 边界

- 只根据工具返回的表结构推断，不猜测不存在的表或字段；看不到的直说看不到。
- 工具返回无权限时只说"只有管理员可以执行初始化"。
- 不读取、不输出任何记录内容或手机号，只处理表结构。
