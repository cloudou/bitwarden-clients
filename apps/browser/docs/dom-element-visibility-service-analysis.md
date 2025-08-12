### DomElementVisibilityService 详细注释文档

> 文件：`src/autofill/services/dom-element-visibility.service.ts`

#### 概述
`DomElementVisibilityService` 用于判定页面上的 DOM 元素是否“可见/可视（viewable）”。它综合考虑：
- 视口边界（尺寸和是否溢出可见区域）
- CSS 隐藏（opacity/display/visibility/clip-path 以及父元素透明度）
- 遮挡情况（元素中心点是否被其它元素覆盖；对内联菜单元素与关联 label 做放行）

服务对 `getComputedStyle` 进行了轻量缓存，以减少同一元素连续读取样式的开销。

---

#### 接口定义（Interface）
```ts 1:4:src/autofill/services/abstractions/dom-element-visibility.service.ts
export interface DomElementVisibilityService {
  isElementViewable: (element: HTMLElement) => Promise<boolean>;
  isElementHiddenByCss: (element: HTMLElement) => boolean;
}
```

---

#### 构造函数
```ts
constructor(private inlineMenuContentService?: AutofillInlineMenuContentService) {}
```
- 可选注入 `inlineMenuContentService`，用于在遮挡判定中识别内联菜单（允许覆盖但不视为遮挡）。

源码：
```ts 8:12:src/autofill/services/dom-element-visibility.service.ts
class DomElementVisibilityService implements DomElementVisibilityServiceInterface {
  private cachedComputedStyle: CSSStyleDeclaration | null = null;

  constructor(private inlineMenuContentService?: AutofillInlineMenuContentService) {}
```

---

#### 公有方法（Public API）

- `async isElementViewable(element: HTMLElement): Promise<boolean>`
  - 功能：判定元素是否对用户“可视”。
  - 判定流程：
    1) 计算元素 `getBoundingClientRect()`；
    2) 若超出视口边界或尺寸过小（`isElementOutsideViewportBounds`）→ 不可视；
    3) 若被 CSS 隐藏（`isElementHiddenByCss`）→ 不可视；
    4) 最后检查中心点是否被其它元素遮挡（`formFieldIsNotHiddenBehindAnotherElement`）→ 返回最终可视性。
  - 适用场景：表单字段是否应展示内联菜单、是否可被交互或作为候选目标等。

源码：
```ts 18:28:src/autofill/services/dom-element-visibility.service.ts
async isElementViewable(element: HTMLElement): Promise<boolean> {
  const elementBoundingClientRect = element.getBoundingClientRect();
  if (
    this.isElementOutsideViewportBounds(element, elementBoundingClientRect) ||
    this.isElementHiddenByCss(element)
  ) {
    return false;
  }

  return this.formFieldIsNotHiddenBehindAnotherElement(element, elementBoundingClientRect);
}
```

- `isElementHiddenByCss(element: HTMLElement): boolean`
  - 功能：判定元素是否被 CSS 隐藏。
  - 规则：
    - opacity < 0.1（`isElementInvisible`）
    - display: none（`isElementNotDisplayed`）
    - visibility: hidden/collapse（`isElementNotVisible`）
    - clip-path 为常见“完全裁剪”形态（`isElementClipped`）
    - 同时上溯父级链路，若任一父元素 opacity < 0.1 也视作隐藏
  - 性能：在单元素的检查链路内使用 `cachedComputedStyle` 缓存，避免重复 `getComputedStyle`。

源码：
```ts 38:61:src/autofill/services/dom-element-visibility.service.ts
isElementHiddenByCss(element: HTMLElement): boolean {
  this.cachedComputedStyle = null;

  if (
    this.isElementInvisible(element) ||
    this.isElementNotDisplayed(element) ||
    this.isElementNotVisible(element) ||
    this.isElementClipped(element)
  ) {
    return true;
  }

  let parentElement = element.parentElement;
  while (parentElement && parentElement !== element.ownerDocument.documentElement) {
    this.cachedComputedStyle = null;
    if (this.isElementInvisible(parentElement)) {
      return true;
    }

    parentElement = parentElement.parentElement;
  }

  return false;
}
```

---

#### 私有方法（Private Helpers）与源码

- `private getElementStyle(element: HTMLElement, styleProperty: string): string`
  - 获取并缓存当前元素的 `computedStyle`，随后读取指定属性值。

源码：
```ts 71:79:src/autofill/services/dom-element-visibility.service.ts
private getElementStyle(element: HTMLElement, styleProperty: string): string {
  if (!this.cachedComputedStyle) {
    this.cachedComputedStyle = (element.ownerDocument.defaultView || globalThis).getComputedStyle(
      element,
    );
  }

  return this.cachedComputedStyle.getPropertyValue(styleProperty);
}
```

- `private isElementInvisible(element: HTMLElement): boolean`
  - `opacity < 0.1` 视作不可见；选取 0.1 阈值以规避亚像素/动画闪烁等。

源码：
```ts 87:89:src/autofill/services/dom-element-visibility.service.ts
private isElementInvisible(element: HTMLElement): boolean {
  return parseFloat(this.getElementStyle(element, "opacity")) < 0.1;
}
```

- `private isElementNotDisplayed(element: HTMLElement): boolean`
  - `display === "none"`。

源码：
```ts 97:99:src/autofill/services/dom-element-visibility.service.ts
private isElementNotDisplayed(element: HTMLElement): boolean {
  return this.getElementStyle(element, "display") === "none";
}
```

- `private isElementNotVisible(element: HTMLElement): boolean`
  - `visibility ∈ {hidden, collapse}`。

源码：
```ts 107:109:src/autofill/services/dom-element-visibility.service.ts
private isElementNotVisible(element: HTMLElement): boolean {
  return new Set(["hidden", "collapse"]).has(this.getElementStyle(element, "visibility"));
}
```

- `private isElementClipped(element: HTMLElement): boolean`
  - `clip-path` 为一组典型“完全裁剪”形态（如 `inset(100%)`, `circle(0)`, 全 0 多边形等）视为隐藏。

源码：
```ts 117:127:src/autofill/services/dom-element-visibility.service.ts
private isElementClipped(element: HTMLElement): boolean {
  return new Set([
    "inset(50%)",
    "inset(100%)",
    "circle(0)",
    "circle(0px)",
    "circle(0px at 50% 50%)",
    "polygon(0 0, 0 0, 0 0, 0 0)",
    "polygon(0px 0px, 0px 0px, 0px 0px, 0px 0px)",
  ]).has(this.getElementStyle(element, "clipPath"));
}
```

- `private isElementOutsideViewportBounds(targetElement, rect?): boolean`
  - 规则：
    - 宽或高 < 10px 视为尺寸不足；
    - 相对于 `documentElement` 的 top/left/width/height 计算是否越界；
  - 返回任一条件命中即为“超出视口边界（不可视）”。

源码：
```ts 137:165:src/autofill/services/dom-element-visibility.service.ts
private isElementOutsideViewportBounds(
  targetElement: HTMLElement,
  targetElementBoundingClientRect: DOMRectReadOnly | null = null,
): boolean {
  const documentElement = targetElement.ownerDocument.documentElement;
  const documentElementWidth = documentElement.scrollWidth;
  const documentElementHeight = documentElement.scrollHeight;
  const elementBoundingClientRect =
    targetElementBoundingClientRect || targetElement.getBoundingClientRect();
  const elementTopOffset = elementBoundingClientRect.top - documentElement.clientTop;
  const elementLeftOffset = elementBoundingClientRect.left - documentElement.clientLeft;

  const isElementSizeInsufficient =
    elementBoundingClientRect.width < 10 || elementBoundingClientRect.height < 10;
  const isElementOverflowingLeftViewport = elementLeftOffset < 0;
  const isElementOverflowingRightViewport =
    elementLeftOffset + elementBoundingClientRect.width > documentElementWidth;
  const isElementOverflowingTopViewport = elementTopOffset < 0;
  const isElementOverflowingBottomViewport =
    elementTopOffset + elementBoundingClientRect.height > documentElementHeight;

  return (
    isElementSizeInsufficient ||
    isElementOverflowingLeftViewport ||
    isElementOverflowingRightViewport ||
    isElementOverflowingTopViewport ||
    isElementOverflowingBottomViewport
  );
}
```

- `private formFieldIsNotHiddenBehindAnotherElement(targetElement, rect?): boolean`
  - 中心点遮挡检测：以元素中心点调用 `elementFromPoint`；
  - 若命中目标本身 → 可视；
  - 若命中内联菜单元素（通过 `inlineMenuContentService.isElementInlineMenu`）→ 视作未被遮挡；
  - 若命中其关联 `label` 或最近的父级 `label` → 视作未被遮挡；
  - 否则视作被遮挡（不可视）。
  - 兼容 Shadow DOM：若在 ShadowRoot 内，从 root 调用 `elementFromPoint`。

源码：
```ts 176:206:src/autofill/services/dom-element-visibility.service.ts
private formFieldIsNotHiddenBehindAnotherElement(
  targetElement: FormFieldElement,
  targetElementBoundingClientRect: DOMRectReadOnly | null = null,
): boolean {
  const elementBoundingClientRect =
    targetElementBoundingClientRect || targetElement.getBoundingClientRect();
  const elementRootNode = targetElement.getRootNode();
  const rootElement =
    elementRootNode instanceof ShadowRoot ? elementRootNode : targetElement.ownerDocument;
  const elementAtCenterPoint = rootElement.elementFromPoint(
    elementBoundingClientRect.left + elementBoundingClientRect.width / 2,
    elementBoundingClientRect.top + elementBoundingClientRect.height / 2,
  );

  if (elementAtCenterPoint === targetElement) {
    return true;
  }

  if (this.inlineMenuContentService?.isElementInlineMenu(elementAtCenterPoint as HTMLElement)) {
    return true;
  }

  const targetElementLabelsSet = new Set((targetElement as FillableFormFieldElement).labels);
  if (targetElementLabelsSet.has(elementAtCenterPoint as HTMLLabelElement)) {
    return true;
  }

  const closestParentLabel = elementAtCenterPoint?.parentElement?.closest("label");

  return targetElementLabelsSet.has(closestParentLabel);
}
```

---

### 方法使用位置（文件/方法清单 + 相关源码）

以下列出本服务每个方法在代码库中的使用位置，并附上相关源码片段（不含仅类型导入）。

- `isElementViewable(element)`
  - `src/autofill/services/collect-autofill-content.service.ts`
    - `updateCachedAutofillFieldVisibility()` 调用：
      ```ts 198:206:src/autofill/services/collect-autofill-content.service.ts
      private updateCachedAutofillFieldVisibility() {
        this.autofillFieldElements.forEach(async (autofillField, element) => {
          const previouslyViewable = autofillField.viewable;
          autofillField.viewable = await this.domElementVisibilityService.isElementViewable(element);

          if (!previouslyViewable && autofillField.viewable) {
            this.setupOverlayOnField(element, autofillField);
          }
        });
      }
      ```
    - `buildAutofillFieldItem(...)` 调用：
      ```ts 362:370:src/autofill/services/collect-autofill-content.service.ts
      const autofillFieldBase = {
        opid: element.opid,
        elementNumber: index,
        maxLength: this.getAutofillFieldMaxLength(element),
        viewable: await this.domElementVisibilityService.isElementViewable(element),
        htmlID: this.getPropertyOrAttribute(element, "id"),
        htmlName: this.getPropertyOrAttribute(element, "name"),
        htmlClass: this.getPropertyOrAttribute(element, "class"),
      };
      ```
    - `handleFormElementIntersection(...)` 调用：
      ```ts 1351:1364:src/autofill/services/collect-autofill-content.service.ts
      const cachedAutofillFieldElement = this.autofillFieldElements.get(formFieldElement);
      if (!cachedAutofillFieldElement) {
        this.intersectionObserver.unobserve(entry.target);
        continue;
      }

      const isViewable = await this.domElementVisibilityService.isElementViewable(formFieldElement);
      if (!isViewable) {
        continue;
      }

      cachedAutofillFieldElement.viewable = true;
      this.setupOverlayOnField(formFieldElement, cachedAutofillFieldElement);
      ```
  - `src/autofill/services/autofill-overlay-content.service.ts`
    - `querySubmitButtonElement(...)` 调用：
      ```ts 555:562:src/autofill/services/autofill-overlay-content.service.ts
      for (let index = 0; index < submitButtonElements.length; index++) {
        const submitElement = submitButtonElements[index];
        if (
          this.isElementSubmitButton(submitElement) &&
          (await this.domElementVisibilityService.isElementViewable(submitElement))
        ) {
          return submitElement;
        }
      }
      ```

- `isElementHiddenByCss(element)`
  - `src/autofill/services/insert-autofill-content.service.ts`
    - `triggerFillAnimationOnElement(...)` 调用：
      ```ts 277:284:src/autofill/services/insert-autofill-content.service.ts
      private triggerFillAnimationOnElement(element: FormFieldElement): void {
        const skipAnimatingElement =
          elementIsFillableFormField(element) &&
          !new Set(["email", "text", "password", "number", "tel", "url"]).has(element?.type);

        if (this.domElementVisibilityService.isElementHiddenByCss(element) || skipAnimatingElement) {
          return;
        }
      }
      ```

---

#### 相关上下游（构造与注入示例，仅供参考）
- 在启动脚本中实例化并注入：
  - `src/autofill/content/bootstrap-autofill.ts`
    ```ts 1:19:src/autofill/content/bootstrap-autofill.ts
    import DomElementVisibilityService from "../services/dom-element-visibility.service";
    // ... 省略若干导入
    (function (windowContext) {
      if (!windowContext.bitwardenAutofillInit) {
        const domQueryService = new DomQueryService();
        const domElementVisibilityService = new DomElementVisibilityService();
        windowContext.bitwardenAutofillInit = new AutofillInit(
          domQueryService,
          domElementVisibilityService,
        );
        setupAutofillInitDisconnectAction(windowContext);

        windowContext.bitwardenAutofillInit.init();
      }
    })(window);
    ```
  - `src/autofill/content/bootstrap-autofill-overlay.ts`
    ```ts 13:38:src/autofill/content/bootstrap-autofill-overlay.ts
    (function (windowContext) {
      if (!windowContext.bitwardenAutofillInit) {
        let inlineMenuContentService: AutofillInlineMenuContentService;
        let overlayNotificationsContentService: OverlayNotificationsContentService;
        if (globalThis.self === globalThis.top) {
          inlineMenuContentService = new AutofillInlineMenuContentService();
          overlayNotificationsContentService = new OverlayNotificationsContentService();
        }

        const domQueryService = new DomQueryService();
        const domElementVisibilityService = new DomElementVisibilityService(inlineMenuContentService);
        const inlineMenuFieldQualificationService = new InlineMenuFieldQualificationService();
        const autofillOverlayContentService = new AutofillOverlayContentService(
          domQueryService,
          domElementVisibilityService,
          inlineMenuFieldQualificationService,
          inlineMenuContentService,
        );

        windowContext.bitwardenAutofillInit = new AutofillInit(
          domQueryService,
          domElementVisibilityService,
          autofillOverlayContentService,
          inlineMenuContentService,
          overlayNotificationsContentService,
        );
        setupAutofillInitDisconnectAction(windowContext);

        windowContext.bitwardenAutofillInit.init();
      }
    })(window);
    ```
- 作为依赖被以下服务使用：
  - `CollectAutofillContentService`（收集页面与字段）
  - `AutofillOverlayContentService`（内联菜单/覆盖层逻辑）
  - `InsertAutofillContentService`（插入/交互行为）
