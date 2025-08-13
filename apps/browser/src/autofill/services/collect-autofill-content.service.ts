// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore

/**
 * 自动填充内容收集服务
 *
 * 该服务负责收集和管理页面中的表单和字段元素信息，用于自动填充功能。
 * 主要功能包括：
 * 1. 识别和分析页面中的表单和字段元素
 * 2. 构建自动填充所需的元数据
 * 3. 监测DOM变化并动态更新元素信息
 * 4. 管理元素的可见性状态
 * 5. 提供自动填充覆盖层支持
 */
import AutofillField from "../models/autofill-field";
import AutofillForm from "../models/autofill-form";
import AutofillPageDetails from "../models/autofill-page-details";
import { ElementWithOpId, FillableFormFieldElement, FormFieldElement } from "../types";
import {
  elementIsDescriptionDetailsElement,
  elementIsDescriptionTermElement,
  elementIsFillableFormField,
  elementIsFormElement,
  elementIsInputElement,
  elementIsLabelElement,
  elementIsSelectElement,
  elementIsSpanElement,
  nodeIsElement,
  elementIsTextAreaElement,
  nodeIsFormElement,
  nodeIsInputElement,
  sendExtensionMessage,
  getAttributeBoolean,
  getPropertyOrAttribute,
  requestIdleCallbackPolyfill,
  cancelIdleCallbackPolyfill,
  debounce,
} from "../utils";

import { AutofillOverlayContentService } from "./abstractions/autofill-overlay-content.service";
import {
  AutofillFieldElements,
  AutofillFormElements,
  CollectAutofillContentService as CollectAutofillContentServiceInterface,
  UpdateAutofillDataAttributeParams,
} from "./abstractions/collect-autofill-content.service";
import { DomElementVisibilityService } from "./abstractions/dom-element-visibility.service";
import { DomQueryService } from "./abstractions/dom-query.service";

/**
 * 自动填充内容收集服务实现类
 *
 * 该类实现了 CollectAutofillContentServiceInterface 接口，
 * 提供完整的页面表单和字段元素收集功能。
 *
 * 核心特性：
 * - 支持Shadow DOM元素收集
 * - 实时DOM变化监测
 * - 智能元素可见性检测
 * - 高性能缓存机制
 * - 覆盖层交互支持
 */
export class CollectAutofillContentService implements CollectAutofillContentServiceInterface {
  // 外部工具方法引用
  private readonly sendExtensionMessage = sendExtensionMessage;
  private readonly getAttributeBoolean = getAttributeBoolean;
  private readonly getPropertyOrAttribute = getPropertyOrAttribute;

  // 状态标识
  private noFieldsFound = false; // 标识是否找到了表单字段
  private domRecentlyMutated = true; // 标识DOM是否最近发生了变化

  // 缓存映射
  private _autofillFormElements: AutofillFormElements = new Map(); // 自动填充表单元素缓存
  private autofillFieldElements: AutofillFieldElements = new Map(); // 自动填充字段元素缓存

  // 位置跟踪
  private currentLocationHref = ""; // 当前页面URL

  // 观察器相关
  private intersectionObserver: IntersectionObserver; // 交叉观察器，用于监测元素可见性
  private elementInitializingIntersectionObserver: Set<Element> = new Set(); // 正在初始化交叉观察器的元素集合
  private mutationObserver: MutationObserver; // DOM变化观察器
  private mutationsQueue: MutationRecord[][] = []; // DOM变化记录队列
  private updateAfterMutationIdleCallback: NodeJS.Timeout | number; // 变化后更新的空闲回调ID
  private readonly updateAfterMutationTimeout = 1000; // 变化后更新的超时时间（毫秒）

  // 查询选择器和配置
  private readonly formFieldQueryString; // 表单字段查询字符串
  private readonly nonInputFormFieldTags = new Set(["textarea", "select"]); // 非input类型的表单字段标签
  private readonly ignoredInputTypes = new Set([
    "hidden", // 隐藏输入框
    "submit", // 提交按钮
    "reset", // 重置按钮
    "button", // 普通按钮
    "image", // 图片按钮
    "file", // 文件上传
  ]); // 被忽略的input类型

  /**
   * 构造函数
   *
   * @param domElementVisibilityService DOM元素可见性服务，用于检测元素是否在视窗中可见
   * @param domQueryService DOM查询服务，提供跨Shadow DOM的元素查询功能
   * @param autofillOverlayContentService 自动填充覆盖层内容服务（可选），用于显示自动填充UI
   */
  constructor(
    private domElementVisibilityService: DomElementVisibilityService,
    private domQueryService: DomQueryService,
    private autofillOverlayContentService?: AutofillOverlayContentService,
  ) {
    // 构建表单字段查询字符串，排除被忽略的input类型
    let inputQuery = "input:not([data-bwignore])"; // 基础input查询，排除标记为忽略的元素
    for (const type of this.ignoredInputTypes) {
      inputQuery += `:not([type="${type}"])`; // 排除每个被忽略的input类型
    }
    // 最终的查询字符串包括：input、textarea、select和带有自动填充标记的span元素
    this.formFieldQueryString = `${inputQuery}, textarea:not([data-bwignore]), select:not([data-bwignore]), span[data-bwautofill]`;
  }

  /**
   * 获取自动填充表单元素映射
   *
   * @returns 返回表单元素到自动填充表单数据的映射关系
   */
  get autofillFormElements(): AutofillFormElements {
    return this._autofillFormElements;
  }

  /**
   * 获取页面详情 - 主要入口方法
   *
   * 构建页面DOM中发现的所有表单和字段的数据。
   * 设置变化观察器来验证DOM变化，如果没有检测到变化则提前返回缓存数据。
   *
   * 核心流程：
   * 1. 初始化观察器（MutationObserver和IntersectionObserver）
   * 2. 检查缓存状态，如果DOM未变化且有缓存数据则直接返回
   * 3. 查询页面中的表单和字段元素
   * 4. 构建自动填充数据结构
   * 5. 设置覆盖层监听器
   *
   * @returns Promise<AutofillPageDetails> 包含页面所有表单和字段信息的详情对象
   * @public
   */
  async getPageDetails(): Promise<AutofillPageDetails> {
    // 如果变化观察器未设置，则设置DOM变化观察器
    if (!this.mutationObserver) {
      this.setupMutationObserver();
    }

    // 如果交叉观察器未设置，则设置交叉观察器
    if (!this.intersectionObserver) {
      this.setupIntersectionObserver();
    }

    // 如果DOM未发生变化且之前没有找到字段，返回空的页面详情
    if (!this.domRecentlyMutated && this.noFieldsFound) {
      return this.getFormattedPageDetails({}, []);
    }

    // 如果DOM未发生变化且有缓存的字段元素，更新可见性并返回缓存数据
    if (!this.domRecentlyMutated && this.autofillFieldElements.size) {
      this.updateCachedAutofillFieldVisibility();

      return this.getFormattedPageDetails(
        this.getFormattedAutofillFormsData(),
        this.getFormattedAutofillFieldsData(),
      );
    }

    // 查询自动填充表单和字段元素
    const { formElements, formFieldElements } = this.queryAutofillFormAndFieldElements();
    // 构建自动填充表单数据
    const autofillFormsData: Record<string, AutofillForm> =
      this.buildAutofillFormsData(formElements);
    // 构建自动填充字段数据
    const autofillFieldsData: AutofillField[] = (
      await this.buildAutofillFieldsData(formFieldElements as FormFieldElement[])
    ).filter((field) => !!field);
    // 排序自动填充字段元素映射
    this.sortAutofillFieldElementsMap();

    // 如果没有找到字段数据，标记为无字段状态
    if (!autofillFieldsData.length) {
      this.noFieldsFound = true;
    }

    // 标记DOM最近未发生变化
    this.domRecentlyMutated = false;
    // 格式化页面详情
    const pageDetails = this.getFormattedPageDetails(autofillFormsData, autofillFieldsData);
    // 设置覆盖层监听器
    this.setupOverlayListeners(pageDetails);

    return pageDetails;
  }

  /**
   * 根据opid查找自动填充字段元素
   *
   * 通过唯一标识符opid查找AutofillField元素，如果存在多个相同opid的元素，
   * 只返回第一个元素。如果没有找到元素，返回null。
   *
   * 查找策略：
   * 1. 首先在缓存的表单字段元素中查找
   * 2. 如果缓存为空，则重新获取所有自动填充字段元素
   * 3. 按opid过滤匹配的元素
   * 4. 如果没有找到，尝试按元素索引查找（opid格式："prefix__index"）
   *
   * @param opid 元素的唯一标识符
   * @returns FormFieldElement | null 找到的表单字段元素或null
   */
  getAutofillFieldElementByOpid(opid: string): FormFieldElement | null {
    // 获取缓存的表单字段元素，如果缓存为空则重新获取
    const cachedFormFieldElements = Array.from(this.autofillFieldElements.keys());
    const formFieldElements = cachedFormFieldElements?.length
      ? cachedFormFieldElements
      : this.getAutofillFieldElements();

    // 过滤出具有指定opid的字段元素
    const fieldElementsWithOpid = formFieldElements.filter(
      (fieldElement) => (fieldElement as ElementWithOpId<FormFieldElement>).opid === opid,
    ) as ElementWithOpId<FormFieldElement>[];

    // 如果没有找到匹配的opid元素，尝试按索引查找
    if (!fieldElementsWithOpid.length) {
      const elementIndex = parseInt(opid.split("__")[1], 10); // 从opid中提取索引

      return formFieldElements[elementIndex] || null;
    }

    // 如果找到多个相同opid的元素，发出警告
    if (fieldElementsWithOpid.length > 1) {
      // eslint-disable-next-line no-console
      console.warn(`More than one element found with opid ${opid}`);
    }

    // 返回第一个匹配的元素
    return fieldElementsWithOpid[0];
  }

  /**
   * 按elementNumber属性排序自动填充字段元素映射
   *
   * 对autofillFieldElements映射进行排序，确保元素按照其在DOM中的顺序排列。
   * 这有助于保持字段的逻辑顺序，便于后续处理。
   *
   * @private
   */
  private sortAutofillFieldElementsMap() {
    // 如果映射为空，直接返回
    if (!this.autofillFieldElements.size) {
      return;
    }

    // 将映射转换为数组，按elementNumber排序，然后重新创建映射
    this.autofillFieldElements = new Map(
      [...this.autofillFieldElements].sort((a, b) => a[1].elementNumber - b[1].elementNumber),
    );
  }

  /**
   * 格式化并返回自动填充页面详情对象
   *
   * 将收集到的表单和字段数据组装成标准的AutofillPageDetails格式，
   * 包含页面的基本信息和所有自动填充相关数据。
   *
   * @param autofillFormsData 页面中发现的所有表单数据
   * @param autofillFieldsData 页面中发现的所有字段数据
   * @returns AutofillPageDetails 格式化的页面详情对象
   * @private
   */
  private getFormattedPageDetails(
    autofillFormsData: Record<string, AutofillForm>,
    autofillFieldsData: AutofillField[],
  ): AutofillPageDetails {
    return {
      title: document.title, // 页面标题
      url: (document.defaultView || globalThis).location.href, // 页面URL
      documentUrl: document.location.href, // 文档URL
      forms: autofillFormsData, // 表单数据
      fields: autofillFieldsData, // 字段数据
      collectedTimestamp: Date.now(), // 收集时间戳
    };
  }

  /**
   * 重新检查所有表单字段的可见性并更新缓存数据
   *
   * 遍历所有缓存的自动填充字段元素，重新检测其可见性状态，
   * 并更新缓存数据以反映最新的可见性状态。如果字段从不可见变为可见，
   * 则在该字段上设置覆盖层。
   *
   * @private
   */
  private updateCachedAutofillFieldVisibility() {
    this.autofillFieldElements.forEach(async (autofillField, element) => {
      const previouslyViewable = autofillField.viewable; // 记录之前的可见性状态
      // 重新检测元素可见性
      autofillField.viewable = await this.domElementVisibilityService.isElementViewable(element);

      // 如果元素从不可见变为可见，设置覆盖层
      if (!previouslyViewable && autofillField.viewable) {
        this.setupOverlayOnField(element, autofillField);
      }
    });
  }

  /**
   * 构建自动填充表单数据
   *
   * 遍历所有表单元素，为每个表单元素分配唯一的opid标识符，
   * 并提取表单的基本属性信息（action、name、class、id、method）。
   * 如果表单元素已存在于缓存中，则更新其opid；否则创建新的表单数据。
   *
   * @param formElements 页面中发现的表单元素数组
   * @returns Record<string, AutofillForm> 表单opid到AutofillForm对象的映射
   * @private
   */
  private buildAutofillFormsData(formElements: Node[]): Record<string, AutofillForm> {
    // 遍历所有表单元素
    for (let index = 0; index < formElements.length; index++) {
      const formElement = formElements[index] as ElementWithOpId<HTMLFormElement>;
      formElement.opid = `__form__${index}`; // 分配唯一标识符

      // 检查表单元素是否已存在于缓存中
      const existingAutofillForm = this._autofillFormElements.get(formElement);
      if (existingAutofillForm) {
        // 更新现有表单的opid
        existingAutofillForm.opid = formElement.opid;
        this._autofillFormElements.set(formElement, existingAutofillForm);
        continue;
      }

      // 为新表单元素创建AutofillForm对象
      this._autofillFormElements.set(formElement, {
        opid: formElement.opid,
        htmlAction: this.getFormActionAttribute(formElement), // 获取表单action属性
        htmlName: this.getPropertyOrAttribute(formElement, "name"), // 获取name属性
        htmlClass: this.getPropertyOrAttribute(formElement, "class"), // 获取class属性
        htmlID: this.getPropertyOrAttribute(formElement, "id"), // 获取id属性
        htmlMethod: this.getPropertyOrAttribute(formElement, "method"), // 获取method属性
      });
    }

    return this.getFormattedAutofillFormsData();
  }

  /**
   * 获取表单元素的action属性
   *
   * 提取表单的action属性值。如果action属性是相对路径，
   * 会将其转换为绝对路径。这确保了无论表单的action值是什么格式，
   * 都能得到完整的URL。
   *
   * @param element 表单元素（带有opid的HTMLFormElement）
   * @returns string 表单的完整action URL
   * @private
   */
  private getFormActionAttribute(element: ElementWithOpId<HTMLFormElement>): string {
    // 使用URL构造函数将相对路径转换为绝对路径
    return new URL(this.getPropertyOrAttribute(element, "action"), globalThis.location.href).href;
  }

  /**
   * 格式化自动填充表单数据
   *
   * 遍历所有已知的表单元素，返回一个包含表单元素opid与表单数据
   * 键值对的AutofillForm对象。将内部的Map结构转换为普通对象格式，
   * 便于序列化和传输。
   *
   * @returns Record<string, AutofillForm> opid到表单数据的映射对象
   * @private
   */
  private getFormattedAutofillFormsData(): Record<string, AutofillForm> {
    const autofillForms: Record<string, AutofillForm> = {}; // 结果对象
    const autofillFormElements = Array.from(this._autofillFormElements); // 转换为数组进行遍历

    // 遍历所有表单元素映射
    for (let index = 0; index < autofillFormElements.length; index++) {
      const [formElement, autofillForm] = autofillFormElements[index];
      autofillForms[formElement.opid] = autofillForm; // 以opid为键存储表单数据
    }

    return autofillForms;
  }

  /**
   * 构建自动填充字段数据
   *
   * 查询DOM中的所有字段元素并返回AutofillField对象列表。
   * 该方法会限制处理的字段数量（默认100个），并为每个字段
   * 构建详细的元数据信息。所有字段构建操作都是异步进行的。
   *
   * @param formFieldElements 表单字段元素数组
   * @returns Promise<AutofillField[]> 自动填充字段对象数组
   * @private
   */
  private async buildAutofillFieldsData(
    formFieldElements: FormFieldElement[],
  ): Promise<AutofillField[]> {
    // 获取限制数量内的自动填充字段元素（默认100个）
    const autofillFieldElements = this.getAutofillFieldElements(100, formFieldElements);

    // 为每个字段元素创建构建任务，返回Promise数组
    const autofillFieldDataPromises = autofillFieldElements.map(this.buildAutofillFieldItem);

    // 等待所有字段构建任务完成
    return Promise.all(autofillFieldDataPromises);
  }

  /**
   * 获取可自动填充的字段元素
   *
   * 查询DOM中所有可以自动填充的字段元素，并返回按优先级排序且
   * 限制在指定数量内的字段列表。优先级策略是将重要字段（如文本输入框）
   * 排在前面，将次要字段（如复选框、单选框）排在后面。
   *
   * @param fieldsLimit 返回字段的最大数量限制
   * @param previouslyFoundFormFieldElements 之前找到的表单字段元素列表
   * @returns FormFieldElement[] 按优先级排序的表单字段元素数组
   * @private
   */
  private getAutofillFieldElements(
    fieldsLimit?: number,
    previouslyFoundFormFieldElements?: FormFieldElement[],
  ): FormFieldElement[] {
    let formFieldElements = previouslyFoundFormFieldElements;

    // 如果没有提供预查找的字段元素，则重新查询
    if (!formFieldElements) {
      formFieldElements = this.domQueryService.query<FormFieldElement>(
        globalThis.document.documentElement,
        this.formFieldQueryString, // 使用构造函数中建立的查询字符串
        (node: Node) => this.isNodeFormFieldElement(node), // 验证节点是否为字段元素
        this.mutationObserver,
      );
    }

    // 如果没有数量限制或字段数量未超过限制，直接返回
    if (!fieldsLimit || formFieldElements.length <= fieldsLimit) {
      return formFieldElements;
    }

    // 按优先级分类字段
    const priorityFormFields: FormFieldElement[] = []; // 优先字段
    const unimportantFormFields: FormFieldElement[] = []; // 次要字段
    const unimportantFieldTypesSet = new Set(["checkbox", "radio"]); // 次要字段类型

    for (const element of formFieldElements) {
      // 如果优先字段已达到限制，直接返回
      if (priorityFormFields.length >= fieldsLimit) {
        return priorityFormFields;
      }

      const fieldType = this.getPropertyOrAttribute(element, "type")?.toLowerCase();

      // 根据字段类型分类
      if (unimportantFieldTypesSet.has(fieldType)) {
        unimportantFormFields.push(element); // 添加到次要字段
        continue;
      }

      priorityFormFields.push(element); // 添加到优先字段
    }

    // 计算还能包含多少次要字段
    const numberUnimportantFieldsToInclude = fieldsLimit - priorityFormFields.length;
    for (let index = 0; index < numberUnimportantFieldsToInclude; index++) {
      priorityFormFields.push(unimportantFormFields[index]);
    }

    return priorityFormFields;
  }

  /**
   * 构建自动填充字段项
   *
   * 从给定的表单元素构建AutofillField对象。对于span元素只返回共享字段值，
   * 对于隐藏的input元素不返回任何标签值。这是构建字段数据的核心方法，
   * 会提取元素的所有相关属性和元数据。
   *
   * 处理流程：
   * 1. 检查元素是否在提交按钮内（如果是则返回null）
   * 2. 分配opid并检查缓存
   * 3. 构建基础字段数据
   * 4. 设置可见性观察器（如果需要）
   * 5. 处理span元素的特殊情况
   * 6. 为非隐藏元素添加标签信息
   * 7. 添加表单相关属性
   * 8. 缓存字段数据
   *
   * @param element 要构建AutofillField对象的表单字段元素
   * @param index 表单字段元素的索引
   * @returns Promise<AutofillField | null> 构建的自动填充字段对象或null
   * @private
   */
  private buildAutofillFieldItem = async (
    element: ElementWithOpId<FormFieldElement>,
    index: number,
  ): Promise<AutofillField | null> => {
    // 如果元素在提交按钮内，跳过处理
    if (element.closest("button[type='submit']")) {
      return null;
    }

    // 分配唯一标识符
    element.opid = `__${index}`;

    // 检查元素是否已存在于缓存中
    const existingAutofillField = this.autofillFieldElements.get(element);
    if (index >= 0 && existingAutofillField) {
      // 更新缓存中的字段信息
      existingAutofillField.opid = element.opid;
      existingAutofillField.elementNumber = index;
      this.autofillFieldElements.set(element, existingAutofillField);

      return existingAutofillField;
    }

    // 构建基础字段数据
    const autofillFieldBase = {
      opid: element.opid, // 唯一标识符
      elementNumber: index, // 元素索引
      maxLength: this.getAutofillFieldMaxLength(element), // 最大长度
      viewable: await this.domElementVisibilityService.isElementViewable(element), // 可见性
      htmlID: this.getPropertyOrAttribute(element, "id"), // HTML ID属性
      htmlName: this.getPropertyOrAttribute(element, "name"), // HTML name属性
      htmlClass: this.getPropertyOrAttribute(element, "class"), // HTML class属性
      tabindex: this.getPropertyOrAttribute(element, "tabindex"), // tabindex属性
      title: this.getPropertyOrAttribute(element, "title"), // title属性
      tagName: this.getAttributeLowerCase(element, "tagName"), // 标签名（小写）
      dataSetValues: this.getDataSetValues(element), // data-*属性值
    };

    // 如果元素不可见，设置交叉观察器进行监测
    if (!autofillFieldBase.viewable) {
      this.elementInitializingIntersectionObserver.add(element);
      this.intersectionObserver?.observe(element);
    }

    // 如果是span元素，直接缓存并返回基础数据
    if (elementIsSpanElement(element)) {
      this.cacheAutofillFieldElement(index, element, autofillFieldBase);
      return autofillFieldBase;
    }

    // 初始化标签对象
    let autofillFieldLabels = {};
    const elementType = this.getAttributeLowerCase(element, "type");

    // 对于非隐藏元素，添加各种标签信息
    if (elementType !== "hidden") {
      autofillFieldLabels = {
        "label-tag": this.createAutofillFieldLabelTag(element as FillableFormFieldElement), // 标签元素
        "label-data": this.getPropertyOrAttribute(element, "data-label"), // data-label属性
        "label-aria": this.getPropertyOrAttribute(element, "aria-label"), // aria-label属性
        "label-top": this.createAutofillFieldTopLabel(element), // 顶部标签
        "label-right": this.createAutofillFieldRightLabel(element), // 右侧标签
        "label-left": this.createAutofillFieldLeftLabel(element), // 左侧标签
        placeholder: this.getPropertyOrAttribute(element, "placeholder"), // placeholder属性
      };
    }

    // 获取关联的表单元素
    const fieldFormElement = (element as ElementWithOpId<FillableFormFieldElement>).form;

    // 构建完整的自动填充字段对象
    const autofillField = {
      ...autofillFieldBase, // 基础字段数据
      ...autofillFieldLabels, // 标签数据
      rel: this.getPropertyOrAttribute(element, "rel"), // rel属性
      type: elementType, // 元素类型
      value: this.getElementValue(element), // 元素值
      checked: this.getAttributeBoolean(element, "checked"), // 选中状态
      autoCompleteType: this.getAutoCompleteAttribute(element), // 自动完成类型
      disabled: this.getAttributeBoolean(element, "disabled"), // 禁用状态
      readonly: this.getAttributeBoolean(element, "readonly"), // 只读状态
      selectInfo: elementIsSelectElement(element)
        ? this.getSelectElementOptions(element as HTMLSelectElement) // 选择框选项
        : null,
      form: fieldFormElement ? this.getPropertyOrAttribute(fieldFormElement, "opid") : null, // 关联表单
      "aria-hidden": this.getAttributeBoolean(element, "aria-hidden", true), // aria-hidden属性
      "aria-disabled": this.getAttributeBoolean(element, "aria-disabled", true), // aria-disabled属性
      "aria-haspopup": this.getAttributeBoolean(element, "aria-haspopup", true), // aria-haspopup属性
      "data-stripe": this.getPropertyOrAttribute(element, "data-stripe"), // Stripe相关属性
    };

    // 缓存自动填充字段元素
    this.cacheAutofillFieldElement(index, element, autofillField);
    return autofillField;
  };

  /**
   * 缓存自动填充字段元素及其数据
   *
   * 将自动填充字段元素和对应的字段数据存储到缓存映射中。
   * 如果索引小于0，则不会缓存该元素。这通常发生在动态添加的元素上，
   * 这些元素需要在下次页面详情收集时重新分配正确的索引。
   *
   * @param index 自动填充字段元素的索引
   * @param element 要缓存的自动填充字段元素
   * @param autofillFieldData 要缓存的自动填充字段数据
   * @private
   */
  private cacheAutofillFieldElement(
    index: number,
    element: ElementWithOpId<FormFieldElement>,
    autofillFieldData: AutofillField,
  ) {
    // 如果索引无效，不进行缓存
    if (index < 0) {
      return;
    }

    // 将元素和数据存储到缓存映射中
    this.autofillFieldElements.set(element, autofillFieldData);
  }

  /**
   * 获取元素的自动完成属性
   *
   * 识别与元素关联的autocomplete属性并返回其值。该方法会按优先级
   * 检查多个可能的自动完成属性：x-autocompletetype、autocompletetype、autocomplete。
   * 这确保了对各种浏览器和历史属性的兼容性。
   *
   * @param element 带有opid的表单字段元素
   * @returns string 自动完成属性值，如果没有找到则返回空字符串
   * @private
   */
  private getAutoCompleteAttribute(element: ElementWithOpId<FormFieldElement>): string {
    return (
      this.getPropertyOrAttribute(element, "x-autocompletetype") || // 优先检查x-autocompletetype
      this.getPropertyOrAttribute(element, "autocompletetype") || // 然后检查autocompletetype
      this.getPropertyOrAttribute(element, "autocomplete") // 最后检查标准autocomplete
    );
  }

  /**
   * 获取元素属性的小写值
   *
   * 获取指定元素的属性值并将其转换为小写形式。这对于
   * 规范化HTML属性值很有用，确保属性比较的一致性。
   *
   * @param element 带有opid的表单字段元素
   * @param attributeName 要获取的属性名称
   * @returns string 属性值的小写形式，如果属性不存在则返回undefined
   * @private
   */
  private getAttributeLowerCase(
    element: ElementWithOpId<FormFieldElement>,
    attributeName: string,
  ): string {
    return this.getPropertyOrAttribute(element, attributeName)?.toLowerCase();
  }

  /**
   * 获取格式化的自动填充字段数据
   *
   * 从autofillFieldElements映射中提取所有字段数据值，
   * 并返回为数组形式。这将内部Map结构转换为可序列化的数组格式。
   *
   * @returns AutofillField[] 自动填充字段数据数组
   * @private
   */
  private getFormattedAutofillFieldsData(): AutofillField[] {
    // 从映射中提取所有值并转换为数组
    return Array.from(this.autofillFieldElements.values());
  }

  /**
   * 创建自动填充字段的标签文本
   *
   * 从与元素关联的标签中提取用于自动填充的标签标签。查找顺序：
   * 1. 通过元素的id、name关联的标签元素
   * 2. 父级标签元素
   * 3. 关联的描述术语元素（如果没有其他标签）
   *
   * 返回包含所有找到的标签元素的textContent或innerText值的字符串。
   *
   * @param element 可填充的表单字段元素
   * @returns string 标签文本内容
   * @private
   */
  private createAutofillFieldLabelTag(element: FillableFormFieldElement): string {
    const labelElementsSet: Set<HTMLElement> = new Set(element.labels);
    if (labelElementsSet.size) {
      return this.createLabelElementsTag(labelElementsSet);
    }

    const labelElements: NodeListOf<HTMLLabelElement> | null = this.queryElementLabels(element);
    for (let labelIndex = 0; labelIndex < labelElements?.length; labelIndex++) {
      labelElementsSet.add(labelElements[labelIndex]);
    }

    let currentElement: HTMLElement | null = element;
    while (currentElement && currentElement !== document.documentElement) {
      if (elementIsLabelElement(currentElement)) {
        labelElementsSet.add(currentElement);
      }

      currentElement = currentElement.parentElement?.closest("label");
    }

    if (
      !labelElementsSet.size &&
      elementIsDescriptionDetailsElement(element.parentElement) &&
      elementIsDescriptionTermElement(element.parentElement.previousElementSibling)
    ) {
      labelElementsSet.add(element.parentElement.previousElementSibling);
    }

    return this.createLabelElementsTag(labelElementsSet);
  }

  /**
   * 查询与给定元素关联的标签元素
   *
   * 通过元素的id或name属性在DOM中查找关联的label元素。
   * 构建查询选择器来查找for属性匹配元素id或name的label标签。
   *
   * 查询策略：
   * 1. 如果元素有id属性，查找label[for="{id}"]
   * 2. 如果元素有name属性，查找label[for="{name}"]
   * 3. 组合多个查询条件
   *
   * @param element 可填充的表单字段元素
   * @returns NodeListOf<HTMLLabelElement> | null 找到的标签元素列表或null
   * @private
   */
  private queryElementLabels(
    element: FillableFormFieldElement,
  ): NodeListOf<HTMLLabelElement> | null {
    let labelQuerySelectors = element.id ? `label[for="${element.id}"]` : "";
    if (element.name) {
      const forElementNameSelector = `label[for="${element.name}"]`;
      labelQuerySelectors = labelQuerySelectors
        ? `${labelQuerySelectors}, ${forElementNameSelector}`
        : forElementNameSelector;
    }

    if (!labelQuerySelectors) {
      return null;
    }

    return (element.getRootNode() as Document | ShadowRoot).querySelectorAll(
      labelQuerySelectors.replace(/\n/g, ""),
    );
  }

  /**
   * 创建标签元素的文本内容
   *
   * 遍历所有标签元素集合，提取每个标签元素的文本内容并拼接成字符串。
   * 对每个标签元素的textContent或innerText进行文本清理和格式化。
   *
   * 处理步骤：
   * 1. 遍历标签元素集合
   * 2. 提取每个元素的文本内容（优先textContent，其次innerText）
   * 3. 清理和修剪文本（去除不可打印字符和多余空格）
   * 4. 拼接所有文本内容
   *
   * @param labelElementsSet 标签元素的集合
   * @returns string 拼接后的标签文本内容
   * @private
   */
  private createLabelElementsTag = (labelElementsSet: Set<HTMLElement>): string => {
    return Array.from(labelElementsSet)
      .map((labelElement) => {
        const textContent: string | null = labelElement
          ? labelElement.textContent || labelElement.innerText
          : null;

        return this.trimAndRemoveNonPrintableText(textContent || "");
      })
      .join("");
  };

  /**
   * 获取表单字段元素的最大长度限制
   *
   * 获取表单字段元素的maxLength属性值。只有input和textarea元素
   * 才具有maxLength属性。为了防止过大的值，将最大长度限制在999。
   *
   * 处理逻辑：
   * 1. 检查元素是否为input或textarea
   * 2. 如果元素有maxLength属性且大于-1，使用该值，否则默认999
   * 3. 返回不超过999的最大长度值
   * 4. 如果元素不支持maxLength属性，返回null
   *
   * @param element 表单字段元素
   * @returns number | null 最大长度值（不超过999）或null
   * @private
   */
  private getAutofillFieldMaxLength(element: FormFieldElement): number | null {
    const elementHasMaxLengthProperty =
      elementIsInputElement(element) || elementIsTextAreaElement(element);
    const elementMaxLength =
      elementHasMaxLengthProperty && element.maxLength > -1 ? element.maxLength : 999;

    return elementHasMaxLengthProperty ? Math.min(elementMaxLength, 999) : null;
  }

  /**
   * 创建字段右侧标签文本
   *
   * 遍历指定元素的后续兄弟节点，收集其文本内容作为右侧标签。
   * 当遇到新的区域元素（如form、button等）时停止遍历，
   * 以避免跨越不相关的内容区域。
   *
   * 遍历策略：
   * 1. 从当前元素开始向后遍历兄弟节点
   * 2. 提取每个节点的文本内容
   * 3. 遇到新区域元素时停止遍历
   * 4. 拼接所有收集到的文本内容
   *
   * @param element 表单字段元素
   * @returns string 右侧标签文本内容
   * @private
   */
  private createAutofillFieldRightLabel(element: FormFieldElement): string {
    const labelTextContent: string[] = [];
    let currentElement: ChildNode = element;

    while (currentElement && currentElement.nextSibling) {
      currentElement = currentElement.nextSibling;
      if (this.isNewSectionElement(currentElement)) {
        break;
      }

      const textContent = this.getTextContentFromElement(currentElement);
      if (textContent) {
        labelTextContent.push(textContent);
      }
    }

    return labelTextContent.join("");
  }

  /**
   * 创建字段左侧标签文本
   *
   * 递归地从元素的前续兄弟节点中获取文本内容，作为字段的左侧标签。
   * 由于是向前遍历，最后需要将结果数组反转以保持正确的文本顺序。
   *
   * 处理方式：
   * 1. 调用递归方法获取前续兄弟节点文本
   * 2. 将结果数组反转（因为是向前遍历）
   * 3. 拼接所有文本内容
   *
   * @param element 表单字段元素
   * @returns string 左侧标签文本内容
   * @private
   */
  private createAutofillFieldLeftLabel(element: FormFieldElement): string {
    const labelTextContent: string[] = this.recursivelyGetTextFromPreviousSiblings(element);

    return labelTextContent.reverse().join("");
  }

  /**
   * 创建字段顶部标签文本（表格中的列标题）
   *
   * 假设要自动填充的输入元素位于表格结构中。查询输入元素
   * 所在行的上一行，并返回同一列中单元格的文本内容作为标签。
   *
   * 查询策略：
   * 1. 找到元素所在的表格单元格（td）
   * 2. 获取单元格的列索引（cellIndex）
   * 3. 找到上一行的相同列的单元格
   * 4. 提取该单元格的文本内容
   *
   * @param element 表单字段元素
   * @returns string | null 顶部标签文本内容或null（如果不在表格中）
   * @private
   */
  private createAutofillFieldTopLabel(element: FormFieldElement): string | null {
    const tableDataElement = element.closest("td");
    if (!tableDataElement) {
      return null;
    }

    const tableDataElementIndex = tableDataElement.cellIndex;
    if (tableDataElementIndex < 0) {
      return null;
    }

    const parentSiblingTableRowElement = tableDataElement.closest("tr")
      ?.previousElementSibling as HTMLTableRowElement;

    return parentSiblingTableRowElement?.cells?.length > tableDataElementIndex
      ? this.getTextContentFromElement(parentSiblingTableRowElement.cells[tableDataElementIndex])
      : null;
  }

  /**
   * 检查元素是否为新区域元素
   *
   * 检查元素的标签是否指示页面过渡到新的区域。如果是，我们
   * 不应该使用该元素或其子元素来为前一个元素获取自动填充上下文。
   *
   * 过渡元素包括：
   * - 结构元素：html, body, head, iframe
   * - 表单元素：form, input, textarea, select, button, option
   * - 其他区域分隔元素：table, script
   *
   * @param currentElement 要检查的HTML元素或节点
   * @returns boolean 如果是新区域元素返回true，否则返回false
   * @private
   */
  private isNewSectionElement(currentElement: HTMLElement | Node): boolean {
    if (!currentElement) {
      return true;
    }

    const transitionalElementTagsSet = new Set([
      "html",
      "body",
      "button",
      "form",
      "head",
      "iframe",
      "input",
      "option",
      "script",
      "select",
      "table",
      "textarea",
    ]);
    return (
      "tagName" in currentElement &&
      transitionalElementTagsSet.has(currentElement.tagName.toLowerCase())
    );
  }

  /**
   * 从传入的元素中获取文本内容
   *
   * 无论传入的是文本节点、元素节点还是HTML元素，都能获取其文本内容。
   * 对于文本节点，直接使用nodeValue；对于元素节点，优先使用textContent，
   * 其次使用innerText。所有文本内容都会经过清理和修剪。
   *
   * 处理策略：
   * 1. 检查节点类型：文本节点使用nodeValue
   * 2. 元素节点使用textContent或innerText
   * 3. 清理和修剪文本内容
   *
   * @param element 节点或HTML元素
   * @returns string 清理后的文本内容
   * @private
   */
  private getTextContentFromElement(element: Node | HTMLElement): string {
    if (element.nodeType === Node.TEXT_NODE) {
      return this.trimAndRemoveNonPrintableText(element.nodeValue);
    }

    return this.trimAndRemoveNonPrintableText(
      element.textContent || (element as HTMLElement).innerText,
    );
  }

  /**
   * 清理文本内容：去除不可打印字符和修剪空白
   *
   * 对传入的文本内容进行清理，去除不可打印的字符并规范化空白。
   * 这有助于获取干净、一致的文本内容，用于自动填充标签的匹配。
   *
   * 清理规则：
   * 1. 去除所有不可打印字符（ASCII 32-126之外的字符）
   * 2. 将多个连续的空白字符替换为单个空格
   * 3. 修剪开头和结尾的空白
   *
   * @param textContent 要清理的文本内容
   * @returns string 清理后的文本内容
   * @private
   */
  private trimAndRemoveNonPrintableText(textContent: string): string {
    return (textContent || "")
      .replace(/[^\x20-\x7E]+|\s+/g, " ") // Strip out non-primitive characters and replace multiple spaces with a single space
      .trim(); // Trim leading and trailing whitespace
  }

  /**
   * 递归获取前续兄弟节点的文本内容
   *
   * 从元素的前续兄弟节点中获取文本内容。如果找不到文本内容，
   * 则递归地从父元素的前续兄弟节点中获取文本内容。
   *
   * 递归策略：
   * 1. 先遍历当前元素的所有前续兄弟
   * 2. 如果找到文本内容或遇到新区域元素，停止遍历
   * 3. 如果没有找到文本内容，递归地向上级父元素的兄弟节点查找
   * 4. 优先考虑元素节点而不是文本节点
   *
   * @param element 要查找前续兄弟文本的元素
   * @returns string[] 收集到的文本内容数组
   * @private
   */
  private recursivelyGetTextFromPreviousSiblings(element: Node | HTMLElement): string[] {
    const textContentItems: string[] = [];
    let currentElement = element;
    while (currentElement && currentElement.previousSibling) {
      // Ensure we are capturing text content from nodes and elements.
      currentElement = currentElement.previousSibling;

      if (this.isNewSectionElement(currentElement)) {
        return textContentItems;
      }

      const textContent = this.getTextContentFromElement(currentElement);
      if (textContent) {
        textContentItems.push(textContent);
      }
    }

    if (!currentElement || textContentItems.length) {
      return textContentItems;
    }

    // Prioritize capturing text content from elements rather than nodes.
    currentElement = currentElement.parentElement || currentElement.parentNode;
    if (!currentElement) {
      return textContentItems;
    }

    let siblingElement = nodeIsElement(currentElement)
      ? currentElement.previousElementSibling
      : currentElement.previousSibling;
    while (siblingElement?.lastChild && !this.isNewSectionElement(siblingElement)) {
      siblingElement = siblingElement.lastChild;
    }

    if (this.isNewSectionElement(siblingElement)) {
      return textContentItems;
    }

    const textContent = this.getTextContentFromElement(siblingElement);
    if (textContent) {
      textContentItems.push(textContent);
      return textContentItems;
    }

    return this.recursivelyGetTextFromPreviousSiblings(siblingElement);
  }

  /**
   * 获取元素的值
   *
   * 获取表单字段元素的值，针对不同类型的元素进行特殊处理：
   * - 复选框：选中返回✓，未选中返回空字符串
   * - 隐藏输入框：如果值超过254个字符，进行截断并添加"...SNIPPED"
   * - span元素：返回textContent或innerText
   * - 其他元素：直接返回value属性
   *
   * @param element 表单字段元素
   * @returns string 元素的值
   * @private
   */
  private getElementValue(element: FormFieldElement): string {
    if (!elementIsFillableFormField(element)) {
      const spanTextContent = element.textContent || element.innerText;
      return spanTextContent || "";
    }

    const elementValue = element.value || "";
    const elementType = String(element.type).toLowerCase();
    if ("checked" in element && elementType === "checkbox") {
      return element.checked ? "✓" : "";
    }

    if (elementType === "hidden") {
      const inputValueMaxLength = 254;

      return elementValue.length > inputValueMaxLength
        ? `${elementValue.substring(0, inputValueMaxLength)}...SNIPPED`
        : elementValue;
    }

    return elementValue;
  }

  /**
   * 获取元素的data-*属性集合
   *
   * 捕获元素的所有data-*属性元数据，用于帮助验证自动填充数据。
   * 遍历元素的dataset属性，将所有键值对格式化为"key: value, "的形式。
   *
   * 示例输出："label: username, validation: required, "
   *
   * @param element 带有opid的表单字段元素
   * @returns string 格式化后的data属性字符串
   * @private
   */
  private getDataSetValues(element: ElementWithOpId<FormFieldElement>): string {
    let datasetValues = "";
    const dataset = element.dataset;
    for (const key in dataset) {
      datasetValues += `${key}: ${dataset[key]}, `;
    }

    return datasetValues;
  }

  /**
   * 获取选择框元素的选项列表
   *
   * 从选择框元素中提取所有选项，返回二维数组，包含每个选项的
   * 文本内容和值。文本内容会被转换为小写并移除所有空格和标点符号。
   *
   * 处理步骤：
   * 1. 遍历选择框的所有选项
   * 2. 对每个选项的文本进行小写转换和清理
   * 3. 移除空格、标点符号和特殊字符
   * 4. 返回[text, value]格式的二维数组
   *
   * @param element 选择框元素
   * @returns 包含选项数据的对象，格式为 {options: [text, value][]}
   * @private
   */
  private getSelectElementOptions(element: HTMLSelectElement): { options: (string | null)[][] } {
    const options = Array.from(element.options).map((option) => {
      const optionText = option.text
        ? String(option.text)
            .toLowerCase()
            .replace(/[\s~`!@$%^&#*()\-_+=:;'"[\]|\\,<.>?]/gm, "") // Remove whitespace and punctuation
        : null;

      return [optionText, option.value];
    });

    return { options };
  }

  /**
   * 查询所有潜在的表单和字段元素
   *
   * 从DOM中查询所有可能的表单和字段元素，并返回分类后的元素集合。
   * 利用TreeWalker API进行深度查询，支持Shadow DOM元素的发现。
   *
   * 查询策略：
   * 1. 使用domQueryService进行跨Shadow DOM查询
   * 2. 同时识别form元素和字段元素
   * 3. 如果第一轮查询没有结果，进行第二轮遍历查询
   *
   * @returns 包含表单元素和字段元素数组的对象
   * @private
   */
  private queryAutofillFormAndFieldElements(): {
    formElements: HTMLFormElement[];
    formFieldElements: FormFieldElement[];
  } {
    const formElements: HTMLFormElement[] = []; // 表单元素数组
    const formFieldElements: FormFieldElement[] = []; // 字段元素数组

    // 使用DOM查询服务进行元素查询，支持Shadow DOM
    const queriedElements = this.domQueryService.query<HTMLElement>(
      globalThis.document.documentElement,
      `form, ${this.formFieldQueryString}`, // 查询表单和字段元素
      (node: Node) => {
        // 判断节点类型并分类存储
        if (nodeIsFormElement(node)) {
          formElements.push(node);
          return true;
        }

        if (this.isNodeFormFieldElement(node)) {
          formFieldElements.push(node as FormFieldElement);
          return true;
        }

        return false;
      },
      this.mutationObserver,
    );

    // 如果查询到了元素，直接返回结果
    if (formElements.length || formFieldElements.length) {
      return { formElements, formFieldElements };
    }

    // 如果第一轮查询没有结果，进行第二轮遍历
    for (let index = 0; index < queriedElements.length; index++) {
      const element = queriedElements[index];
      if (elementIsFormElement(element)) {
        formElements.push(element);
        continue;
      }

      if (this.isNodeFormFieldElement(element)) {
        formFieldElements.push(element);
      }
    }

    return { formElements, formFieldElements };
  }

  /**
   * 检查传入的节点是否为表单字段元素
   *
   * 判断DOM节点是否符合自动填充字段的条件。包括：
   * - 带有data-bwautofill属性的span元素
   * - 非被忽略类型的input元素
   * - textarea和select元素（非被忽略的）
   *
   * @param node 要检查的DOM节点
   * @returns boolean 如果是表单字段元素返回true，否则返回false
   * @private
   */
  private isNodeFormFieldElement(node: Node): boolean {
    // 确保节点是元素节点
    if (!nodeIsElement(node)) {
      return false;
    }

    const nodeTagName = node.tagName.toLowerCase(); // 获取小写标签名

    // 检查是否为带有自动填充属性的span元素
    const nodeIsSpanElementWithAutofillAttribute =
      nodeTagName === "span" && node.hasAttribute("data-bwautofill");
    if (nodeIsSpanElementWithAutofillAttribute) {
      return true;
    }

    // 检查节点是否有忽略属性
    const nodeHasBwIgnoreAttribute = node.hasAttribute("data-bwignore");

    // 检查是否为有效的input元素（不在忽略类型列表中）
    const nodeIsValidInputElement =
      nodeTagName === "input" && !this.ignoredInputTypes.has((node as HTMLInputElement).type);
    if (nodeIsValidInputElement && !nodeHasBwIgnoreAttribute) {
      return true;
    }

    // 检查是否为非input类型的表单字段标签（textarea、select）
    return this.nonInputFormFieldTags.has(nodeTagName) && !nodeHasBwIgnoreAttribute;
  }

  /**
   * 在文档上设置DOM变化观察器
   *
   * 创建并配置MutationObserver来监听DOM元素的变化，确保我们拥有
   * 最新的自动填充字段数据。观察器会监听属性变化、子节点变化等。
   *
   * 监听配置：
   * - attributes: true - 监听属性变化
   * - childList: true - 监听子节点添加/删除
   * - subtree: true - 监听整个子树的变化
   *
   * @private
   */
  private setupMutationObserver() {
    // 记录当前页面URL
    this.currentLocationHref = globalThis.location.href;

    // 创建变化观察器，绑定处理函数
    this.mutationObserver = new MutationObserver(this.handleMutationObserverMutation);

    // 开始观察文档元素的变化
    this.mutationObserver.observe(document.documentElement, {
      attributes: true, // 监听属性变化
      childList: true, // 监听子节点变化
      subtree: true, // 监听整个子树
    });
  }

  /**
   * 处理观察到的DOM变化
   *
   * 当MutationObserver检测到DOM变化时调用此方法。首先检查是否为页面URL变化，
   * 如果是则处理页面导航；否则将变化记录加入队列进行批量处理。
   *
   * 处理策略：
   * 1. 优先检查URL变化（页面导航）
   * 2. 将变化记录添加到队列中
   * 3. 使用防抖机制批量处理变化
   *
   * @param mutations DOM变化记录数组
   * @private
   */
  private handleMutationObserverMutation = (mutations: MutationRecord[]) => {
    // 检查页面URL是否发生变化
    if (this.currentLocationHref !== globalThis.location.href) {
      this.handleWindowLocationMutation(); // 处理URL变化

      return;
    }

    // 如果队列为空，启动防抖处理机制
    if (!this.mutationsQueue.length) {
      requestIdleCallbackPolyfill(debounce(this.processMutations, 100), { timeout: 500 });
    }

    // 将变化记录添加到队列中
    this.mutationsQueue.push(mutations);
  };

  /**
   * 处理窗口URL变化的情况
   *
   * 当检测到页面URL发生变化时调用此方法。该方法会清除所有自动填充元素缓存，
   * 并在超时后重新更新自动填充元素数据。这确保了当用户导航到新页面时，
   * 自动填充功能能够正确地重新初始化。
   *
   * 处理步骤：
   * 1. 更新当前页面URL记录
   * 2. 标记DOM已发生变化
   * 3. 清除用户填充字段和关闭内联菜单
   * 4. 清空表单和字段元素缓存
   * 5. 触发变化后的元素更新
   *
   * @private
   */
  private handleWindowLocationMutation() {
    // 更新当前页面URL记录
    this.currentLocationHref = globalThis.location.href;

    // 标记DOM最近发生了变化
    this.domRecentlyMutated = true;

    // 如果存在覆盖层内容服务，进行相关清理
    if (this.autofillOverlayContentService) {
      this.autofillOverlayContentService.pageDetailsUpdateRequired = true; // 标记需要更新页面详情
      this.autofillOverlayContentService.clearUserFilledFields(); // 清除用户填充的字段
      // 强制关闭自动填充内联菜单
      void this.sendExtensionMessage("closeAutofillInlineMenu", { forceCloseInlineMenu: true });
    }

    // 重置字段查找状态
    this.noFieldsFound = false;

    // 清空所有缓存的表单和字段元素
    this._autofillFormElements.clear();
    this.autofillFieldElements.clear();

    // 触发变化后的自动填充元素更新
    this.updateAutofillElementsAfterMutation();
  }

  /**
   * 处理变化队列中的所有变化记录
   *
   * 在空闲回调中触发，有助于提高性能并防止过度更新。
   * 遍历队列中的所有变化记录，逐一处理并清空队列。
   *
   * 处理步骤：
   * 1. 检查是否需要检测Shadow DOM
   * 2. 遍历所有队列中的变化记录
   * 3. 在空闲回调中处理每组变化记录
   * 4. 在最后一次处理后触发元素更新
   * 5. 清空变化队列
   *
   * @private
   */
  private processMutations = () => {
    const queueLength = this.mutationsQueue.length;

    if (!this.domQueryService.pageContainsShadowDomElements()) {
      this.checkPageContainsShadowDom();
    }

    for (let queueIndex = 0; queueIndex < queueLength; queueIndex++) {
      const mutations = this.mutationsQueue[queueIndex];
      const processMutationRecords = () => {
        this.processMutationRecords(mutations);

        if (queueIndex === queueLength - 1 && this.domRecentlyMutated) {
          this.updateAutofillElementsAfterMutation();
        }
      };

      requestIdleCallbackPolyfill(processMutationRecords, { timeout: 500 });
    }

    this.mutationsQueue = [];
  };

  /**
   * 检查当前页面是否包含Shadow DOM元素
   *
   * 检查当前页面是否包含Shadow DOM元素，如果包含则标记需要
   * 重新收集页面详情。Shadow DOM元素可能包含新的表单字段，
   * 需要重新收集以确保完整性。
   *
   * @private
   */
  private checkPageContainsShadowDom() {
    this.domQueryService.checkPageContainsShadowDom();
    if (this.domQueryService.pageContainsShadowDomElements()) {
      this.flagPageDetailsUpdateIsRequired();
    }
  }

  /**
   * 标记需要更新页面详情
   *
   * 触发多个标志，指示在DOM变化后的后续调用中应再次收集页面详情。
   * 这些标志包括：DOM最近变化标志、覆盖层服务更新标志和重置字段查找状态。
   *
   * @private
   */
  private flagPageDetailsUpdateIsRequired() {
    this.domRecentlyMutated = true;
    if (this.autofillOverlayContentService) {
      this.autofillOverlayContentService.pageDetailsUpdateRequired = true;
    }
    this.noFieldsFound = false;
  }

  /**
   * 处理变化观察器遇到的所有变化记录
   *
   * 遍历所有变化记录并逐个处理。为了提高性能，每个变化记录
   * 都在空闲回调中进行处理，避免阻塞主线程。
   *
   * @param mutations 要处理的变化记录数组
   * @private
   */
  private processMutationRecords(mutations: MutationRecord[]) {
    for (let mutationIndex = 0; mutationIndex < mutations.length; mutationIndex++) {
      const mutation: MutationRecord = mutations[mutationIndex];
      const processMutationRecord = () => this.processMutationRecord(mutation);
      requestIdleCallbackPolyfill(processMutationRecord, { timeout: 500 });
    }
  }

  /**
   * 处理单个变化记录并在必要时更新自动填充元素
   *
   * 根据变化记录的类型进行不同的处理：
   * - childList变化：检查添加或删除的节点是否为自动填充元素
   * - attributes变化：处理自动填充元素的属性变化
   *
   * @param mutation 单个变化记录
   * @private
   */
  private processMutationRecord(mutation: MutationRecord) {
    if (
      mutation.type === "childList" &&
      (this.isAutofillElementNodeMutated(mutation.removedNodes, true) ||
        this.isAutofillElementNodeMutated(mutation.addedNodes))
    ) {
      this.flagPageDetailsUpdateIsRequired();
      return;
    }

    if (mutation.type === "attributes") {
      this.handleAutofillElementAttributeMutation(mutation);
    }
  }

  /**
   * 检查传入的节点是否包含或本身就是自动填充元素
   *
   * 遍历节点列表，检查每个节点及其子节点是否为表单或字段元素。
   * 如果正在删除节点，则从缓存中移除相应的元素；如果是添加节点，
   * 则为新元素设置覆盖层监听器。
   *
   * @param nodes 要检查的节点列表
   * @param isRemovingNodes 是否正在删除节点
   * @returns boolean 如果有元素发生变化返回true
   * @private
   */
  private isAutofillElementNodeMutated(nodes: NodeList, isRemovingNodes = false): boolean {
    if (!nodes.length) {
      return false;
    }

    let isElementMutated = false;
    let mutatedElements: HTMLElement[] = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (!nodeIsElement(node)) {
        continue;
      }

      if (nodeIsFormElement(node) || this.isNodeFormFieldElement(node)) {
        mutatedElements.push(node as HTMLElement);
      }

      const autofillElements = this.domQueryService.query<HTMLElement>(
        node,
        `form, ${this.formFieldQueryString}`,
        (walkerNode: Node) =>
          nodeIsFormElement(walkerNode) || this.isNodeFormFieldElement(walkerNode),
        this.mutationObserver,
        true,
      );

      if (autofillElements.length) {
        mutatedElements = mutatedElements.concat(autofillElements);
      }

      if (mutatedElements.length) {
        isElementMutated = true;
      }
    }

    if (isRemovingNodes) {
      for (let elementIndex = 0; elementIndex < mutatedElements.length; elementIndex++) {
        const element = mutatedElements[elementIndex];
        this.deleteCachedAutofillElement(
          element as ElementWithOpId<HTMLFormElement> | ElementWithOpId<FormFieldElement>,
        );
      }
    } else if (this.autofillOverlayContentService) {
      this.setupOverlayListenersOnMutatedElements(mutatedElements);
    }

    return isElementMutated;
  }

  /**
   * 在变化元素上设置覆盖层监听器
   *
   * 在传入的变化元素上设置覆盖层监听器。这确保了在初始页面加载后
   * 注入DOM的元素上也能显示覆盖层。对于每个节点，将在空闲回调中
   * 构建自动填充字段项。
   *
   * @param mutatedElements 已变化的HTML元素数组
   * @private
   */
  private setupOverlayListenersOnMutatedElements(mutatedElements: Node[]) {
    for (let elementIndex = 0; elementIndex < mutatedElements.length; elementIndex++) {
      const node = mutatedElements[elementIndex];
      const buildAutofillFieldItem = () => {
        if (
          !this.isNodeFormFieldElement(node) ||
          this.autofillFieldElements.get(node as ElementWithOpId<FormFieldElement>)
        ) {
          return;
        }

        // We are setting this item to a -1 index because we do not know its position in the DOM.
        // This value should be updated with the next call to collect page details.
        void this.buildAutofillFieldItem(node as ElementWithOpId<FormFieldElement>, -1);
      };

      requestIdleCallbackPolyfill(buildAutofillFieldItem, { timeout: 1000 });
    }
  }

  /**
   * 删除从 DOM 中移除的缓存自动填充元素
   *
   * 当元素从DOM中被删除时，从相应的缓存映射中移除该元素。
   * 首先检查元素是否为表单元素，如果是则从表单元素缓存中移除；
   * 否则检查字段元素缓存并移除。
   *
   * @param element 要从缓存中删除的元素（带有opid的表单或字段元素）
   * @private
   */
  private deleteCachedAutofillElement(
    element: ElementWithOpId<HTMLFormElement> | ElementWithOpId<FormFieldElement>,
  ) {
    if (elementIsFormElement(element) && this._autofillFormElements.has(element)) {
      this._autofillFormElements.delete(element);
      return;
    }

    if (this.autofillFieldElements.has(element)) {
      this.autofillFieldElements.delete(element);
    }
  }

  /**
   * 在DOM变化后更新自动填充元素
   *
   * 在DOM发生变化后更新自动填充元素。使用防抖机制防止过度更新。
   * 如果已有待处理的空闲回调，先取消再设置新的回调。
   * 最终会调用getPageDetails方法重新收集页面数据。
   *
   * @private
   */
  private updateAutofillElementsAfterMutation() {
    if (this.updateAfterMutationIdleCallback) {
      cancelIdleCallbackPolyfill(this.updateAfterMutationIdleCallback);
    }

    this.updateAfterMutationIdleCallback = requestIdleCallbackPolyfill(
      this.getPageDetails.bind(this),
      { timeout: this.updateAfterMutationTimeout },
    );
  }

  /**
   * 处理观察到的与自动填充元素属性相关的DOM变化
   *
   * 当自动填充元素的属性发生变化时，更新缓存中的元素数据。
   * 首先检查是否为表单元素，如果是则更新表单数据；否则检查是否为
   * 字段元素并更新字段数据。
   *
   * @param mutation 变化记录
   * @private
   */
  private handleAutofillElementAttributeMutation(mutation: MutationRecord) {
    // 获取发生属性变化的目标元素
    const targetElement = mutation.target;

    // 确保目标是一个DOM元素节点，如果不是则直接返回
    if (!nodeIsElement(targetElement)) {
      return;
    }

    // 获取变化的属性名称并转换为小写，确保属性名称的一致性
    const attributeName = mutation.attributeName?.toLowerCase();

    // 首先检查该元素是否为已缓存的自动填充表单元素
    const autofillForm = this._autofillFormElements.get(
      targetElement as ElementWithOpId<HTMLFormElement>,
    );

    // 如果找到了对应的表单元素缓存数据
    if (autofillForm) {
      // 更新表单元素的相关数据（如action、name、id、method等属性）
      this.updateAutofillFormElementData(
        attributeName,
        targetElement as ElementWithOpId<HTMLFormElement>,
        autofillForm,
      );

      return; // 处理完表单元素后直接返回
    }

    // 如果不是表单元素，检查是否为已缓存的自动填充字段元素
    const autofillField = this.autofillFieldElements.get(
      targetElement as ElementWithOpId<FormFieldElement>,
    );

    // 如果没有找到对应的字段元素缓存数据，说明这个元素不在我们的监控范围内
    if (!autofillField) {
      return;
    }

    // 更新字段元素的相关数据（如maxlength、id、name、class、type、value等属性）
    this.updateAutofillFieldElementData(
      attributeName,
      targetElement as ElementWithOpId<FormFieldElement>,
      autofillField,
    );
  }

  /**
   * 根据传入的属性名更新自动填充表单元素数据
   *
   * 根据变化的属性名称更新表单元素的相应数据字段。
   * 支持的属性包括：action、name、id、method等。
   * 更新完成后将新数据保存到缓存映射中。
   *
   * @param attributeName 变化的属性名称
   * @param element 带有opid的表单元素
   * @param dataTarget 要更新的自动填充表单数据对象
   * @private
   */
  private updateAutofillFormElementData(
    attributeName: string,
    element: ElementWithOpId<HTMLFormElement>,
    dataTarget: AutofillForm,
  ) {
    const updateAttribute = (dataTargetKey: string) => {
      this.updateAutofillDataAttribute({ element, attributeName, dataTarget, dataTargetKey });
    };
    const updateActions: Record<string, CallableFunction> = {
      action: () => (dataTarget.htmlAction = this.getFormActionAttribute(element)),
      name: () => updateAttribute("htmlName"),
      id: () => updateAttribute("htmlID"),
      method: () => updateAttribute("htmlMethod"),
    };

    if (!updateActions[attributeName]) {
      return;
    }

    updateActions[attributeName]();
    if (this._autofillFormElements.has(element)) {
      this._autofillFormElements.set(element, dataTarget);
    }
  }

  /**
   * 根据传入的属性名更新自动填充字段元素数据
   *
   * 根据变化的属性名称更新字段元素的相应数据字段。
   * 支持的属性包括：maxlength、id、name、class、type、value、checked等。
   * 也支持aria和data相关属性的更新。更新完成后将新数据保存到缓存映射中。
   *
   * @param attributeName 变化的属性名称
   * @param element 带有opid的表单字段元素
   * @param dataTarget 要更新的自动填充字段数据对象
   * @private
   */
  private updateAutofillFieldElementData(
    attributeName: string,
    element: ElementWithOpId<FormFieldElement>,
    dataTarget: AutofillField,
  ) {
    const updateAttribute = (dataTargetKey: string) => {
      this.updateAutofillDataAttribute({ element, attributeName, dataTarget, dataTargetKey });
    };
    const updateActions: Record<string, CallableFunction> = {
      maxlength: () => (dataTarget.maxLength = this.getAutofillFieldMaxLength(element)),
      id: () => updateAttribute("htmlID"),
      name: () => updateAttribute("htmlName"),
      class: () => updateAttribute("htmlClass"),
      tabindex: () => updateAttribute("tabindex"),
      title: () => updateAttribute("tabindex"),
      rel: () => updateAttribute("rel"),
      tagname: () => (dataTarget.tagName = this.getAttributeLowerCase(element, "tagName")),
      type: () => (dataTarget.type = this.getAttributeLowerCase(element, "type")),
      value: () => (dataTarget.value = this.getElementValue(element)),
      checked: () => (dataTarget.checked = this.getAttributeBoolean(element, "checked")),
      disabled: () => (dataTarget.disabled = this.getAttributeBoolean(element, "disabled")),
      readonly: () => (dataTarget.readonly = this.getAttributeBoolean(element, "readonly")),
      autocomplete: () => (dataTarget.autoCompleteType = this.getAutoCompleteAttribute(element)),
      "data-label": () => updateAttribute("label-data"),
      "aria-label": () => updateAttribute("label-aria"),
      "aria-hidden": () =>
        (dataTarget["aria-hidden"] = this.getAttributeBoolean(element, "aria-hidden", true)),
      "aria-disabled": () =>
        (dataTarget["aria-disabled"] = this.getAttributeBoolean(element, "aria-disabled", true)),
      "aria-haspopup": () =>
        (dataTarget["aria-haspopup"] = this.getAttributeBoolean(element, "aria-haspopup", true)),
      "data-stripe": () => updateAttribute("data-stripe"),
    };

    if (!updateActions[attributeName]) {
      return;
    }

    updateActions[attributeName]();

    if (this.autofillFieldElements.has(element)) {
      this.autofillFieldElements.set(element, dataTarget);
    }
  }

  /**
   * 获取元素的属性值并返回
   *
   * 从指定元素获取指定属性的值。如果提供了dataTarget和dataTargetKey参数，
   * 则会将获取的属性值设置到dataTarget[dataTargetKey]中。
   * 这是一个通用的属性更新工具方法。
   *
   * @param params 更新参数对象，包含元素、属性名、目标对象和目标属性键
   * @returns string 属性值
   * @private
   */
  private updateAutofillDataAttribute({
    element,
    attributeName,
    dataTarget,
    dataTargetKey,
  }: UpdateAutofillDataAttributeParams) {
    const attributeValue = this.getPropertyOrAttribute(element, attributeName);
    if (dataTarget && dataTargetKey) {
      dataTarget[dataTargetKey] = attributeValue;
    }

    return attributeValue;
  }

  /**
   * 设置交叉观察器来观察在视口中不可见的表单字段元素
   *
   * 创建一个交叉观察器来监控那些在视口中不可见的表单字段元素。
   * 当这些元素进入视口时，会触发相应的处理逻辑。
   *
   * 观察器配置：
   * - root: null（使用浏览器视口作为根）
   * - rootMargin: "0px"（无边距）
   * - threshold: 1.0（元素完全可见时触发）
   *
   * @private
   */
  private setupIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver(this.handleFormElementIntersection, {
      root: null,
      rootMargin: "0px",
      threshold: 1.0,
    });
  }

  /**
   * 处理在视口中不可见的观察表单字段元素
   *
   * 当之前不可见的表单字段元素进入视口时，重新评估其可见性并
   * 在元素可见时为其设置自动填充覆盖层监听器。
   *
   * 处理步骤：
   * 1. 遍历所有交叉观察器条目
   * 2. 跳过正在初始化的元素
   * 3. 检查元素是否在缓存中
   * 4. 重新检测元素可见性
   * 5. 如果可见，设置覆盖层并停止观察
   *
   * @param entries 交叉观察器观察到的条目数组
   * @private
   */
  private handleFormElementIntersection = async (entries: IntersectionObserverEntry[]) => {
    // 遍历交叉观察器观察到的所有条目
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      // 获取触发交叉观察的表单字段元素
      const formFieldElement = entry.target as ElementWithOpId<FormFieldElement>;

      // 检查该元素是否正在初始化交叉观察器（避免重复处理）
      if (this.elementInitializingIntersectionObserver.has(formFieldElement)) {
        // 从初始化集合中移除该元素，跳过本次处理
        this.elementInitializingIntersectionObserver.delete(formFieldElement);
        continue;
      }

      // 从缓存中获取该元素对应的自动填充字段数据
      const cachedAutofillFieldElement = this.autofillFieldElements.get(formFieldElement);

      // 如果在缓存中未找到该元素的数据，说明该元素已被移除或不再需要监控
      if (!cachedAutofillFieldElement) {
        // 停止观察该元素，释放资源
        this.intersectionObserver.unobserve(entry.target);
        continue;
      }

      // 使用可见性服务重新检测元素的真实可见性状态
      // （交叉观察器只能检测元素是否进入视口，但不能检测CSS样式等影响的可见性）
      const isViewable = await this.domElementVisibilityService.isElementViewable(formFieldElement);

      // 如果元素仍然不可见，继续等待下次交叉观察触发
      if (!isViewable) {
        continue;
      }

      // 更新缓存中的可见性状态为true
      cachedAutofillFieldElement.viewable = true;

      // 为该字段元素设置自动填充覆盖层，使其能够显示自动填充建议
      this.setupOverlayOnField(formFieldElement, cachedAutofillFieldElement);

      // 元素已可见且已设置覆盖层，停止继续观察该元素
      this.intersectionObserver?.unobserve(entry.target);
    }
  };

  /**
   * 遍历所有缓存字段元素并为每个字段设置内联菜单监听器
   *
   * 在所有缓存的字段元素上设置覆盖层监听器，使它们能够显示
   * 自动填充覆盖层界面。需要自动填充覆盖层内容服务支持。
   *
   * @param pageDetails 用于内联菜单监听器的页面详情
   * @private
   */
  private setupOverlayListeners(pageDetails: AutofillPageDetails) {
    if (this.autofillOverlayContentService) {
      this.autofillFieldElements.forEach((autofillField, formFieldElement) => {
        this.setupOverlayOnField(formFieldElement, autofillField, pageDetails);
      });
    }
  }

  /**
   * 在指定字段元素上设置内联菜单监听器
   *
   * 为传入的表单字段元素设置自动填充覆盖层监听器。
   * 如果没有提供页面详情，会自动生成一个。这使得字段能够
   * 显示自动填充建议和交互界面。
   *
   * @param formFieldElement 要设置内联菜单监听器的表单字段元素
   * @param autofillField 表单字段的元数据
   * @param pageDetails 用于内联菜单监听器的页面详情（可选）
   * @private
   */
  private setupOverlayOnField(
    formFieldElement: ElementWithOpId<FormFieldElement>,
    autofillField: AutofillField,
    pageDetails?: AutofillPageDetails,
  ) {
    if (this.autofillOverlayContentService) {
      const autofillPageDetails =
        pageDetails ||
        this.getFormattedPageDetails(
          this.getFormattedAutofillFormsData(),
          this.getFormattedAutofillFieldsData(),
        );

      void this.autofillOverlayContentService.setupOverlayListeners(
        formFieldElement,
        autofillField,
        autofillPageDetails,
      );
    }
  }

  /**
   * 验证文档中是否存在密码字段
   *
   * 在整个文档中搜索密码类型的input元素，用于判断当前页面
   * 是否包含密码字段。这有助于确定是否需要启用密码相关的
   * 自动填充功能。
   *
   * @returns boolean 如果文档中存在密码字段返回true，否则返回false
   */
  isPasswordFieldWithinDocument(): boolean {
    return (
      this.domQueryService.query<HTMLInputElement>(
        globalThis.document.documentElement,
        `input[type="password"]`, // 查询密码类型的input元素
        (node: Node) => nodeIsInputElement(node) && node.type === "password", // 验证节点确实是密码输入框
      )?.length > 0
    );
  }

  /**
   * 销毁自动填充内容收集服务
   *
   * 清理服务使用的所有资源，包括：
   * - 取消待处理的空闲回调
   * - 断开DOM变化观察器
   * - 断开交叉观察器
   *
   * 此方法应在服务不再需要时调用，以防止内存泄漏和不必要的DOM监听。
   */
  destroy() {
    // 如果存在待处理的变化后更新回调，取消它
    if (this.updateAfterMutationIdleCallback) {
      cancelIdleCallbackPolyfill(this.updateAfterMutationIdleCallback);
    }

    // 断开DOM变化观察器连接
    this.mutationObserver?.disconnect();

    // 断开交叉观察器连接
    this.intersectionObserver?.disconnect();
  }
}
