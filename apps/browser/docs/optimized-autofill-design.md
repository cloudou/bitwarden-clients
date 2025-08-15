# 优化的自动填充系统设计方案

## 1. 系统概述

本方案设计了一个基于RxJS的高性能自动填充系统，通过优化的数据结构和算法实现快速的表单元素查找和自动填充。

### 核心特性

- **高效的数据结构**：使用索引映射加速元素查找
- **RxJS响应式监听**：实时响应DOM变化和用户交互
- **智能关联算法**：自动识别相关的表单字段
- **渐进式填充**：按设定间隔执行填充操作，避免触发网站的反作弊机制

## 2. 核心数据结构

### 2.1 OptimizedPageDetail

```typescript
interface OptimizedPageDetail {
  // 页面基础信息
  url: string;
  title: string;
  timestamp: number;

  // 表单集合（使用Map提高查找效率）
  forms: Map<string, OptimizedForm>;

  // 字段集合（使用Map提高查找效率）
  fields: Map<string, OptimizedField>;

  // 索引结构（用于快速查找）
  indices: {
    // 通过元素引用快速查找字段
    elementToField: WeakMap<Element, OptimizedField>;

    // 通过表单ID查找其包含的字段
    formToFields: Map<string, Set<string>>;

    // 通过字段类型分组
    fieldsByType: Map<FieldType, Set<string>>;

    // 关联字段映射（如用户名->密码）
    fieldRelations: Map<string, Set<string>>;

    // 邻近字段映射（物理位置相近的字段）
    proximityMap: Map<string, Set<string>>;
  };

  // 性能优化缓存
  cache: {
    // 最近访问的字段（LRU缓存）
    recentFields: LRUCache<string, OptimizedField>;

    // 计算过的关系缓存
    computedRelations: Map<string, CachedRelation>;
  };
}
```

### 2.2 OptimizedForm

```typescript
interface OptimizedForm {
  id: string;
  element: HTMLFormElement;

  // 表单属性
  action: string;
  method: string;
  name: string;
  className: string;

  // 包含的字段ID列表
  fieldIds: string[];

  // 表单类型识别
  formType: FormType; // 'login' | 'signup' | 'payment' | 'profile' | 'unknown'

  // 表单状态
  isVisible: boolean;
  isInteractive: boolean;

  // 元数据
  metadata: {
    hasPasswordField: boolean;
    hasEmailField: boolean;
    fieldCount: number;
    visibleFieldCount: number;
  };
}
```

### 2.3 OptimizedField

```typescript
interface OptimizedField {
  id: string;
  element: HTMLElement;

  // 基础属性
  type: string;
  name: string;
  htmlId: string;
  className: string;
  placeholder: string;

  // 标签信息
  labels: {
    tag: string;
    aria: string;
    placeholder: string;
    computed: string; // 综合计算的标签
  };

  // 位置信息
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
    tabIndex: number;
    documentOrder: number; // 在文档中的顺序
  };

  // 状态信息
  state: {
    isVisible: boolean;
    isFocused: boolean;
    isDisabled: boolean;
    isReadonly: boolean;
    hasValue: boolean;
    value: string;
  };

  // 字段类型识别
  fieldType: FieldClassification; // 'username' | 'password' | 'email' | 'name' | 'tel' | etc.
  confidence: number; // 类型识别的置信度 0-1

  // 关联信息
  formId: string | null;
  relatedFieldIds: string[]; // 相关字段ID
  proximityFieldIds: string[]; // 邻近字段ID
}
```

### 2.4 字段类型枚举

```typescript
enum FieldClassification {
  // 登录相关
  Username = "username",
  Password = "password",
  NewPassword = "newPassword",
  ConfirmPassword = "confirmPassword",

  // 个人信息
  Email = "email",
  FirstName = "firstName",
  LastName = "lastName",
  FullName = "fullName",
  Phone = "phone",

  // 地址信息
  Address = "address",
  City = "city",
  State = "state",
  PostalCode = "postalCode",
  Country = "country",

  // 支付信息
  CardNumber = "cardNumber",
  CardHolder = "cardHolder",
  CardExpiry = "cardExpiry",
  CardCVC = "cardCVC",

  // 其他
  Search = "search",
  Captcha = "captcha",
  Unknown = "unknown",
}
```

## 3. RxJS监听系统

### 3.1 DOM监听器

```typescript
class DOMObserverService {
  private destroy$ = new Subject<void>();

  // DOM变化流
  private domMutations$ = new Subject<MutationRecord[]>();

  // 焦点事件流
  private focusEvents$ = new Subject<FocusEvent>();

  // 点击事件流
  private clickEvents$ = new Subject<MouseEvent>();

  // 输入事件流
  private inputEvents$ = new Subject<InputEvent>();

  constructor() {
    this.initializeObservers();
  }

  private initializeObservers(): void {
    // MutationObserver for DOM changes
    const mutationObserver = new MutationObserver((mutations) => {
      this.domMutations$.next(mutations);
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "disabled", "readonly", "style", "class"],
    });

    // Event listeners with RxJS
    fromEvent<FocusEvent>(document, "focusin", { capture: true })
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => this.focusEvents$.next(event));

    fromEvent<MouseEvent>(document, "click", { capture: true })
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => this.clickEvents$.next(event));

    fromEvent<InputEvent>(document, "input", { capture: true })
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => this.inputEvents$.next(event));
  }

  // 获取聚合的交互事件流
  getInteractionEvents$(): Observable<InteractionEvent> {
    return merge(
      this.focusEvents$.pipe(map((e) => ({ type: "focus", event: e }))),
      this.clickEvents$.pipe(map((e) => ({ type: "click", event: e }))),
    ).pipe(
      // 防抖处理，避免重复事件
      debounceTime(50),
      // 过滤掉非表单元素
      filter(({ event }) => this.isFormElement(event.target)),
    );
  }

  // 获取DOM变化流（带防抖）
  getDOMChanges$(): Observable<DOMChange> {
    return this.domMutations$.pipe(
      // 批量处理变化
      bufferTime(100),
      filter((mutations) => mutations.length > 0),
      map((mutations) => this.processMutations(mutations)),
    );
  }
}
```

### 3.2 表单元素查找服务

```typescript
class FormElementFinderService {
  private pageDetail: OptimizedPageDetail;

  constructor(private pageDetail: OptimizedPageDetail) {}

  // 根据元素查找对应的字段
  findFieldByElement(element: Element): OptimizedField | null {
    return this.pageDetail.indices.elementToField.get(element) || null;
  }

  // 查找相关的所有字段
  findRelatedFields(fieldId: string): OptimizedField[] {
    const field = this.pageDetail.fields.get(fieldId);
    if (!field) return [];

    const relatedIds = new Set<string>();

    // 1. 添加同表单的字段
    if (field.formId) {
      const formFields = this.pageDetail.indices.formToFields.get(field.formId);
      if (formFields) {
        formFields.forEach((id) => relatedIds.add(id));
      }
    }

    // 2. 添加显式关联的字段
    field.relatedFieldIds.forEach((id) => relatedIds.add(id));

    // 3. 添加通过关系映射找到的字段
    const relations = this.pageDetail.indices.fieldRelations.get(fieldId);
    if (relations) {
      relations.forEach((id) => relatedIds.add(id));
    }

    // 4. 智能推断相关字段（如用户名->密码）
    const inferredFields = this.inferRelatedFields(field);
    inferredFields.forEach((f) => relatedIds.add(f.id));

    // 移除自身
    relatedIds.delete(fieldId);

    // 转换为字段对象数组
    return Array.from(relatedIds)
      .map((id) => this.pageDetail.fields.get(id))
      .filter((f) => f !== undefined) as OptimizedField[];
  }

  // 智能推断相关字段
  private inferRelatedFields(field: OptimizedField): OptimizedField[] {
    const related: OptimizedField[] = [];

    switch (field.fieldType) {
      case FieldClassification.Username:
      case FieldClassification.Email:
        // 查找密码字段
        const passwordFields = this.pageDetail.indices.fieldsByType.get(
          FieldClassification.Password,
        );
        if (passwordFields) {
          passwordFields.forEach((id) => {
            const pwField = this.pageDetail.fields.get(id);
            if (pwField && this.areFieldsRelated(field, pwField)) {
              related.push(pwField);
            }
          });
        }
        break;

      case FieldClassification.Password:
        // 查找用户名/邮箱字段
        const usernameFields = [
          ...(this.pageDetail.indices.fieldsByType.get(FieldClassification.Username) || []),
          ...(this.pageDetail.indices.fieldsByType.get(FieldClassification.Email) || []),
        ];
        usernameFields.forEach((id) => {
          const unField = this.pageDetail.fields.get(id);
          if (unField && this.areFieldsRelated(field, unField)) {
            related.push(unField);
          }
        });
        break;

      case FieldClassification.CardNumber:
        // 查找其他支付相关字段
        [
          FieldClassification.CardHolder,
          FieldClassification.CardExpiry,
          FieldClassification.CardCVC,
        ].forEach((type) => {
          const fields = this.pageDetail.indices.fieldsByType.get(type);
          if (fields) {
            fields.forEach((id) => {
              const f = this.pageDetail.fields.get(id);
              if (f) related.push(f);
            });
          }
        });
        break;
    }

    return related;
  }

  // 判断两个字段是否相关
  private areFieldsRelated(field1: OptimizedField, field2: OptimizedField): boolean {
    // 同一表单内的字段
    if (field1.formId && field1.formId === field2.formId) {
      return true;
    }

    // 物理位置接近的字段
    const distance = this.calculateDistance(field1.position, field2.position);
    if (distance < 500) {
      // 500像素内认为相关
      return true;
    }

    // Tab顺序相近
    if (Math.abs(field1.position.tabIndex - field2.position.tabIndex) <= 2) {
      return true;
    }

    return false;
  }

  private calculateDistance(pos1: any, pos2: any): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
```

## 4. 自动填充执行器

### 4.1 填充执行服务

```typescript
class AutoFillExecutor {
  private fillQueue$ = new Subject<FillTask>();
  private fillDelay = 25; // 默认25ms间隔

  constructor() {
    this.initializeFillProcessor();
  }

  private initializeFillProcessor(): void {
    this.fillQueue$
      .pipe(
        // 按顺序处理，每个任务间隔指定时间
        concatMap((task) =>
          of(task).pipe(
            tap((t) => this.executeFillTask(t)),
            delay(this.fillDelay),
          ),
        ),
      )
      .subscribe();
  }

  // 执行自动填充
  async autoFill(
    fields: OptimizedField[],
    values: Map<string, string>,
    options: FillOptions = {},
  ): Promise<void> {
    const tasks = this.createFillTasks(fields, values, options);

    // 将任务加入队列
    tasks.forEach((task) => this.fillQueue$.next(task));
  }

  private createFillTasks(
    fields: OptimizedField[],
    values: Map<string, string>,
    options: FillOptions,
  ): FillTask[] {
    const tasks: FillTask[] = [];

    // 按优先级排序字段
    const sortedFields = this.sortFieldsByPriority(fields);

    for (const field of sortedFields) {
      const value = values.get(field.id);
      if (!value) continue;

      // 创建填充任务序列
      if (options.includeClick !== false) {
        tasks.push({
          type: "click",
          field,
          value: null,
        });
      }

      if (options.includeFocus !== false) {
        tasks.push({
          type: "focus",
          field,
          value: null,
        });
      }

      tasks.push({
        type: "fill",
        field,
        value,
      });

      // 触发change事件
      if (options.triggerEvents !== false) {
        tasks.push({
          type: "event",
          field,
          value: null,
          eventType: "change",
        });
      }
    }

    return tasks;
  }

  private executeFillTask(task: FillTask): void {
    const element = task.field.element as HTMLInputElement;

    switch (task.type) {
      case "click":
        element.click();
        break;

      case "focus":
        element.focus();
        break;

      case "fill":
        if (task.value) {
          // 模拟真实输入
          this.simulateTyping(element, task.value);
        }
        break;

      case "event":
        if (task.eventType) {
          element.dispatchEvent(new Event(task.eventType, { bubbles: true }));
        }
        break;
    }
  }

  private simulateTyping(element: HTMLInputElement, value: string): void {
    // 清空现有值
    element.value = "";
    element.dispatchEvent(new Event("input", { bubbles: true }));

    // 逐字符输入（可选，用于更真实的模拟）
    if (this.shouldSimulateRealTyping(element)) {
      let currentValue = "";
      for (const char of value) {
        currentValue += char;
        element.value = currentValue;
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: char,
            inputType: "insertText",
          }),
        );
      }
    } else {
      // 直接设置值
      element.value = value;
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        }),
      );
    }
  }

  private shouldSimulateRealTyping(element: HTMLInputElement): boolean {
    // 对于某些敏感字段，使用更真实的输入模拟
    return element.type === "password" || element.getAttribute("data-sensitive") === "true";
  }

  private sortFieldsByPriority(fields: OptimizedField[]): OptimizedField[] {
    return fields.sort((a, b) => {
      // 优先级规则：
      // 1. 用户名/邮箱优先
      // 2. 密码其次
      // 3. 按tab顺序
      // 4. 按文档顺序

      const priorityMap: Record<FieldClassification, number> = {
        [FieldClassification.Username]: 1,
        [FieldClassification.Email]: 1,
        [FieldClassification.Password]: 2,
        [FieldClassification.NewPassword]: 3,
        // ... 其他字段类型
      };

      const aPriority = priorityMap[a.fieldType] || 99;
      const bPriority = priorityMap[b.fieldType] || 99;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // 相同优先级，按tab顺序
      if (a.position.tabIndex !== b.position.tabIndex) {
        return a.position.tabIndex - b.position.tabIndex;
      }

      // 最后按文档顺序
      return a.position.documentOrder - b.position.documentOrder;
    });
  }
}
```

### 4.2 填充任务接口

```typescript
interface FillTask {
  type: "click" | "focus" | "fill" | "event";
  field: OptimizedField;
  value: string | null;
  eventType?: string;
}

interface FillOptions {
  includeClick?: boolean;
  includeFocus?: boolean;
  triggerEvents?: boolean;
  delay?: number;
  simulateRealTyping?: boolean;
}
```

## 5. 主控制器

### 5.1 自动填充主服务

```typescript
class OptimizedAutofillService {
  private pageDetail: OptimizedPageDetail;
  private domObserver: DOMObserverService;
  private elementFinder: FormElementFinderService;
  private fillExecutor: AutoFillExecutor;
  private destroy$ = new Subject<void>();

  constructor() {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    // 1. 收集页面信息
    this.pageDetail = await this.collectPageDetails();

    // 2. 初始化服务
    this.domObserver = new DOMObserverService();
    this.elementFinder = new FormElementFinderService(this.pageDetail);
    this.fillExecutor = new AutoFillExecutor();

    // 3. 设置监听器
    this.setupListeners();
  }

  private setupListeners(): void {
    // 监听用户交互
    this.domObserver
      .getInteractionEvents$()
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => this.handleInteraction(event));

    // 监听DOM变化
    this.domObserver
      .getDOMChanges$()
      .pipe(
        takeUntil(this.destroy$),
        debounceTime(500), // 防抖500ms
      )
      .subscribe((change) => this.handleDOMChange(change));
  }

  private async handleInteraction(event: InteractionEvent): Promise<void> {
    const element = event.event.target as Element;
    const field = this.elementFinder.findFieldByElement(element);

    if (!field) return;

    // 查找相关字段
    const relatedFields = this.elementFinder.findRelatedFields(field.id);

    // 准备填充数据
    const fillData = await this.prepareFillData([field, ...relatedFields]);

    if (fillData.size > 0) {
      // 执行自动填充
      await this.fillExecutor.autoFill([field, ...relatedFields], fillData, {
        includeClick: true,
        includeFocus: true,
        triggerEvents: true,
        delay: 25,
      });
    }
  }

  private async handleDOMChange(change: DOMChange): Promise<void> {
    // 更新页面详情
    if (change.hasNewForms || change.hasNewFields) {
      await this.updatePageDetails(change);
    }
  }

  private async collectPageDetails(): Promise<OptimizedPageDetail> {
    // 收集所有表单和字段
    const forms = new Map<string, OptimizedForm>();
    const fields = new Map<string, OptimizedField>();
    const indices = this.createIndices();

    // 查询所有表单
    const formElements = document.querySelectorAll("form");
    formElements.forEach((form, index) => {
      const optimizedForm = this.analyzeForm(form as HTMLFormElement, index);
      forms.set(optimizedForm.id, optimizedForm);
    });

    // 查询所有字段（包括表单外的）
    const fieldSelector = 'input, textarea, select, [contenteditable="true"]';
    const fieldElements = document.querySelectorAll(fieldSelector);

    fieldElements.forEach((element, index) => {
      const optimizedField = this.analyzeField(element as HTMLElement, index);
      fields.set(optimizedField.id, optimizedField);

      // 建立索引
      indices.elementToField.set(element, optimizedField);

      // 按类型分组
      if (!indices.fieldsByType.has(optimizedField.fieldType)) {
        indices.fieldsByType.set(optimizedField.fieldType, new Set());
      }
      indices.fieldsByType.get(optimizedField.fieldType)!.add(optimizedField.id);

      // 关联到表单
      if (optimizedField.formId) {
        if (!indices.formToFields.has(optimizedField.formId)) {
          indices.formToFields.set(optimizedField.formId, new Set());
        }
        indices.formToFields.get(optimizedField.formId)!.add(optimizedField.id);
      }
    });

    // 建立字段关系
    this.buildFieldRelations(fields, indices);

    return {
      url: window.location.href,
      title: document.title,
      timestamp: Date.now(),
      forms,
      fields,
      indices,
      cache: {
        recentFields: new LRUCache({ max: 50 }),
        computedRelations: new Map(),
      },
    };
  }

  private analyzeForm(form: HTMLFormElement, index: number): OptimizedForm {
    const formId = `form_${index}`;
    const fields = form.querySelectorAll("input, textarea, select");

    return {
      id: formId,
      element: form,
      action: form.action,
      method: form.method,
      name: form.name,
      className: form.className,
      fieldIds: [],
      formType: this.detectFormType(form),
      isVisible: this.isElementVisible(form),
      isInteractive: !form.disabled,
      metadata: {
        hasPasswordField: !!form.querySelector('input[type="password"]'),
        hasEmailField: !!form.querySelector('input[type="email"]'),
        fieldCount: fields.length,
        visibleFieldCount: Array.from(fields).filter((f) => this.isElementVisible(f as HTMLElement))
          .length,
      },
    };
  }

  private analyzeField(element: HTMLElement, index: number): OptimizedField {
    const fieldId = `field_${index}`;
    const rect = element.getBoundingClientRect();

    return {
      id: fieldId,
      element,
      type: (element as HTMLInputElement).type || element.tagName.toLowerCase(),
      name: (element as HTMLInputElement).name || "",
      htmlId: element.id,
      className: element.className,
      placeholder: (element as HTMLInputElement).placeholder || "",
      labels: this.extractLabels(element),
      position: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        tabIndex: element.tabIndex,
        documentOrder: index,
      },
      state: {
        isVisible: this.isElementVisible(element),
        isFocused: element === document.activeElement,
        isDisabled: (element as HTMLInputElement).disabled || false,
        isReadonly: (element as HTMLInputElement).readOnly || false,
        hasValue: !!(element as HTMLInputElement).value,
        value: (element as HTMLInputElement).value || "",
      },
      fieldType: this.classifyField(element),
      confidence: 0.8, // 简化示例
      formId: this.findParentForm(element),
      relatedFieldIds: [],
      proximityFieldIds: [],
    };
  }

  private classifyField(element: HTMLElement): FieldClassification {
    const input = element as HTMLInputElement;
    const type = input.type?.toLowerCase();
    const name = input.name?.toLowerCase();
    const id = input.id?.toLowerCase();
    const placeholder = input.placeholder?.toLowerCase();
    const label = this.getFieldLabel(element)?.toLowerCase();

    // 组合所有线索
    const hints = `${type} ${name} ${id} ${placeholder} ${label}`.toLowerCase();

    // 模式匹配
    if (type === "password") return FieldClassification.Password;
    if (type === "email" || hints.includes("email")) return FieldClassification.Email;
    if (hints.includes("username") || hints.includes("user")) return FieldClassification.Username;
    if (hints.includes("phone") || hints.includes("tel")) return FieldClassification.Phone;
    if (hints.includes("card") && hints.includes("number")) return FieldClassification.CardNumber;
    if (hints.includes("cvv") || hints.includes("cvc")) return FieldClassification.CardCVC;
    if (hints.includes("expir")) return FieldClassification.CardExpiry;
    if (hints.includes("search")) return FieldClassification.Search;

    return FieldClassification.Unknown;
  }

  private buildFieldRelations(fields: Map<string, OptimizedField>, indices: any): void {
    // 建立字段之间的关系
    fields.forEach((field, fieldId) => {
      const relatedIds = new Set<string>();

      // 查找邻近字段
      fields.forEach((otherField, otherId) => {
        if (fieldId === otherId) return;

        // 计算距离
        const distance = this.calculateDistance(field.position, otherField.position);
        if (distance < 300) {
          field.proximityFieldIds.push(otherId);

          // 如果是特定类型组合，建立关联
          if (this.shouldRelateFields(field, otherField)) {
            relatedIds.add(otherId);
          }
        }
      });

      if (relatedIds.size > 0) {
        indices.fieldRelations.set(fieldId, relatedIds);
      }
    });
  }

  private shouldRelateFields(field1: OptimizedField, field2: OptimizedField): boolean {
    const relatedPairs = [
      [FieldClassification.Username, FieldClassification.Password],
      [FieldClassification.Email, FieldClassification.Password],
      [FieldClassification.CardNumber, FieldClassification.CardExpiry],
      [FieldClassification.CardNumber, FieldClassification.CardCVC],
      [FieldClassification.Password, FieldClassification.ConfirmPassword],
    ];

    return relatedPairs.some(
      ([type1, type2]) =>
        (field1.fieldType === type1 && field2.fieldType === type2) ||
        (field1.fieldType === type2 && field2.fieldType === type1),
    );
  }

  // 工具方法
  private isElementVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return !!(
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  private extractLabels(element: HTMLElement): any {
    // 实现标签提取逻辑
    return {
      tag: this.getFieldLabel(element) || "",
      aria: element.getAttribute("aria-label") || "",
      placeholder: (element as HTMLInputElement).placeholder || "",
      computed: "", // 综合计算
    };
  }

  private getFieldLabel(element: HTMLElement): string {
    // 查找关联的label元素
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.textContent || "";
    }

    // 查找父级label
    const parentLabel = element.closest("label");
    if (parentLabel) return parentLabel.textContent || "";

    return "";
  }

  private findParentForm(element: HTMLElement): string | null {
    const form = element.closest("form");
    if (!form) return null;

    // 查找表单ID
    for (const [formId, formData] of this.pageDetail.forms) {
      if (formData.element === form) {
        return formId;
      }
    }

    return null;
  }

  private detectFormType(form: HTMLFormElement): FormType {
    const hasPassword = !!form.querySelector('input[type="password"]');
    const hasEmail = !!form.querySelector('input[type="email"]');
    const hasCardNumber = !!form.querySelector('[name*="card"], [id*="card"]');

    if (hasPassword && !form.querySelector('input[type="password"][name*="confirm"]')) {
      return "login";
    }
    if (hasPassword && form.querySelector('input[type="password"][name*="confirm"]')) {
      return "signup";
    }
    if (hasCardNumber) {
      return "payment";
    }

    return "unknown";
  }

  private calculateDistance(pos1: any, pos2: any): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private createIndices(): any {
    return {
      elementToField: new WeakMap(),
      formToFields: new Map(),
      fieldsByType: new Map(),
      fieldRelations: new Map(),
      proximityMap: new Map(),
    };
  }

  private async prepareFillData(fields: OptimizedField[]): Promise<Map<string, string>> {
    const fillData = new Map<string, string>();

    // 这里应该从密码管理器获取实际数据
    // 简化示例：
    fields.forEach((field) => {
      switch (field.fieldType) {
        case FieldClassification.Username:
        case FieldClassification.Email:
          fillData.set(field.id, "user@example.com");
          break;
        case FieldClassification.Password:
          fillData.set(field.id, "SecurePassword123!");
          break;
        // ... 其他字段类型
      }
    });

    return fillData;
  }

  private async updatePageDetails(change: DOMChange): Promise<void> {
    // 增量更新页面详情
    // 实现省略...
  }

  destroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
```

## 6. 性能优化策略

### 6.1 缓存机制

- **LRU缓存**：缓存最近访问的字段，减少重复查找
- **关系缓存**：缓存计算过的字段关系，避免重复计算
- **索引结构**：使用WeakMap和Map建立多维索引，O(1)查找

### 6.2 查找优化

- **多级索引**：通过元素引用、表单ID、字段类型等多个维度建立索引
- **邻近性映射**：预计算字段之间的物理距离，加速相关字段查找
- **智能推断**：基于字段类型和位置关系智能推断关联

### 6.3 填充优化

- **批量处理**：将多个填充操作合并，减少DOM操作
- **渐进式填充**：按优先级和间隔时间逐步填充，避免触发反作弊
- **事件模拟**：正确触发input、change等事件，确保表单验证通过

## 7. 使用示例

```typescript
// 初始化服务
const autofillService = new OptimizedAutofillService();

// 服务会自动监听用户交互
// 当用户点击或聚焦表单字段时，自动触发填充

// 手动触发填充
async function manualFill() {
  const usernameField = document.querySelector("#username");
  if (usernameField) {
    await autofillService.fillFieldAndRelated(usernameField, {
      username: "user@example.com",
      password: "SecurePassword123!",
    });
  }
}

// 清理
window.addEventListener("unload", () => {
  autofillService.destroy();
});
```

## 8. 安全考虑

1. **避免敏感数据泄露**：所有密码等敏感数据应加密存储
2. **防止XSS攻击**：验证填充的数据，避免执行恶意脚本
3. **域名验证**：只在可信的域名上执行自动填充
4. **用户确认**：对于敏感操作，需要用户确认

## 9. 总结

本方案通过以下关键技术实现了高效的自动填充：

1. **优化的数据结构**：使用索引和缓存加速查找
2. **RxJS响应式编程**：实时响应DOM变化和用户交互
3. **智能关联算法**：自动识别相关字段
4. **渐进式填充**：模拟真实用户输入行为

这个系统能够：

- 快速响应用户交互（毫秒级）
- 准确识别表单字段类型
- 智能关联相关字段
- 安全可靠地执行自动填充
