/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import {TemplateResult} from 'lit-html';
import {render} from 'lit-html/lib/shady-render';

import {PropertyValues, UpdatingElement} from './lib/updating-element.js';

export * from './lib/updating-element.js';
export * from './lib/decorators.js';
export {html, svg, TemplateResult, SVGTemplateResult} from 'lit-html/lit-html';
import {supportsAdoptingStyleSheets, CSSResult} from './lib/css-tag.js';
export * from './lib/css-tag.js';

export interface CSSResultArray extends Array<CSSResult | CSSResultArray> {}

/**
 * Minimal implementation of Array.prototype.flat
 * @param arr the array to flatten
 * @param result the accumlated result
 */
function arrayFlat(styles: CSSResultArray, result: CSSResult[] = []): CSSResult[] {
  for (let i = 0, length = styles.length; i < length; i++) {
    const value = styles[i];
    if (Array.isArray(value)) {
      arrayFlat(value, result);
    } else {
      result.push(value);
    }
  }
  return result;
}

function getClosestStyleConfigCtor(ctor: Function) {
  let closestStyleConfigCtor = ctor.hasOwnProperty(JSCompiler_renameProperty('styles', ctor)) ? ctor : null;
  let superCtor = Object.getPrototypeOf(ctor);
  // if `styles` not on current constructor level, get closest parent with `styles`
  while (superCtor && !closestStyleConfigCtor && !superCtor.hasOwnProperty(JSCompiler_renameProperty('styles', ctor))) {
    superCtor = Object.getPrototypeOf(ctor);
    closestStyleConfigCtor = superCtor.styles ? superCtor : null;
  }
  return closestStyleConfigCtor;
}

/** Deeply flattens styles array. Uses native flat if available. */
const flattenStyles = (styles: CSSResultArray): CSSResult[] => styles.flat ? styles.flat(Infinity) : arrayFlat(styles);

export class LitElement extends UpdatingElement {

  /**
   * Ensure this class is marked as `finalized` as an optimization ensuring
   * it will not needlessly try to `finalize`.
   */
  protected static finalized = true;

  /**
   * Render method used to render the lit-html TemplateResult to the element's
   * DOM.
   * @param {TemplateResult} Template to render.
   * @param {Element|DocumentFragment} Node into which to render.
   * @param {String} Element name.
   * @nocollapse
   */
  static render = render;

  /**
   * Array of styles to apply to the element. The styles should be defined
   * using the `css` tag function.
   */
  static styles?: CSSResult | CSSResultArray;

  private static _styles: CSSResult[]|undefined;

  private static __closestCreatedStylesCtor?: Function;

  private static get _uniqueStyles(): CSSResult[] {
    if (!this.hasOwnProperty(JSCompiler_renameProperty('_styles', this))) {
      // Inherit styles from superclass if none have been set.
      if (!this[JSCompiler_renameProperty('styles', this)]) {
        this._styles = [];
      }
      // Only create a new style array when needed: this would be when the closest
      // (parent) `styles` config is at a higher level in the constructor chain
      // hierarchy than the last ones (this._styles) created.
      else if (getClosestStyleConfigCtor(this) !== this.__closestCreatedStylesCtor) {
        // Take care not to call `this.styles` multiple times since this generates
        // new CSSResults each time.
        // TODO(sorvell): Since we do not cache CSSResults by input, any
        // shared styles will generate new stylesheet objects, which is wasteful.
        // This should be addressed when a browser ships constructable
        // stylesheets.
        const userStyles = this.styles;
        if (Array.isArray(userStyles)) {
          const styles = flattenStyles(userStyles);
          // As a performance optimization to avoid duplicated styling that can
          // occur especially when composing via subclassing, de-duplicate styles
          // preserving the last item in the list. The last item is kept to
          // try to preserve cascade order with the assumption that it's most
          // important that last added styles override previous styles.
          const styleSet = styles.reduceRight((set, s) => {
            set.add(s);
            // on IE set.add does not return the set.
            return set;
          }, new Set<CSSResult>());
          // Array.from does not work on Set in IE
          this._styles = [];
          styleSet.forEach((v) => this._styles!.unshift(v));
        } else {
          this._styles = userStyles ? [userStyles] : [];
        }
        this.__closestCreatedStylesCtor = this;
      }
    }
    return this._styles as CSSResult[];
  }

  private _needsShimAdoptedStyleSheets?: boolean;

  /**
   * Node or ShadowRoot into which element DOM should be rendered. Defaults
   * to an open shadowRoot.
   */
  protected renderRoot?: Element|DocumentFragment;

  /**
   * Performs element initialization. By default this calls `createRenderRoot`
   * to create the element `renderRoot` node and captures any pre-set values for
   * registered properties.
   */
  protected initialize() {
    super.initialize();
    this.renderRoot = this.createRenderRoot();
    // Note, if renderRoot is not a shadowRoot, styles would/could apply to the
    // element's getRootNode(). While this could be done, we're choosing not to
    // support this now since it would require different logic around de-duping.
    if (window.ShadowRoot && this.renderRoot instanceof window.ShadowRoot) {
      this.adoptStyles();
    }
  }

  /**
   * Returns the node into which the element should render and by default
   * creates and returns an open shadowRoot. Implement to customize where the
   * element's DOM is rendered. For example, to render into the element's
   * childNodes, return `this`.
   * @returns {Element|DocumentFragment} Returns a node into which to render.
   */
  protected createRenderRoot(): Element|ShadowRoot {
    return this.attachShadow({mode : 'open'});
  }

  /**
   * Applies styling to the element shadowRoot using the `static get styles`
   * property. Styling will apply using `shadowRoot.adoptedStyleSheets` where
   * available and will fallback otherwise. When Shadow DOM is polyfilled,
   * ShadyCSS scopes styles and adds them to the document. When Shadow DOM
   * is available but `adoptedStyleSheets` is not, styles are appended to the
   * end of the `shadowRoot` to [mimic spec
   * behavior](https://wicg.github.io/construct-stylesheets/#using-constructed-stylesheets).
   */
  protected adoptStyles() {
    const styles = (this.constructor as typeof LitElement)._uniqueStyles;
    if (styles.length === 0) {
      return;
    }
    // There are three separate cases here based on Shadow DOM support.
    // (1) shadowRoot polyfilled: use ShadyCSS
    // (2) shadowRoot.adoptedStyleSheets available: use it.
    // (3) shadowRoot.adoptedStyleSheets polyfilled: append styles after
    // rendering
    if (window.ShadyCSS !== undefined && !window.ShadyCSS.nativeShadow) {
      window.ShadyCSS.ScopingShim.prepareAdoptedCssText(
          styles.map((s) => s.cssText), this.localName);
    } else if (supportsAdoptingStyleSheets) {
      (this.renderRoot as ShadowRoot).adoptedStyleSheets =
          styles.map((s) => s.styleSheet!);
    } else {
      // This must be done after rendering so the actual style insertion is done
      // in `update`.
      this._needsShimAdoptedStyleSheets = true;
    }
  }

  connectedCallback() {
    super.connectedCallback();
    // Note, first update/render handles styleElement so we only call this if
    // connected after first update.
    if (this.hasUpdated && window.ShadyCSS !== undefined) {
      window.ShadyCSS.styleElement(this);
    }
  }

  /**
   * Updates the element. This method reflects property values to attributes
   * and calls `render` to render DOM via lit-html. Setting properties inside
   * this method will *not* trigger another update.
   * * @param _changedProperties Map of changed properties with old values
   */
  protected update(changedProperties: PropertyValues) {
    super.update(changedProperties);
    const templateResult = this.render() as any;
    if (templateResult instanceof TemplateResult) {
      (this.constructor as typeof LitElement)
          .render(templateResult, this.renderRoot!,
                  {scopeName : this.localName!, eventContext : this});
    }
    // When native Shadow DOM is used but adoptedStyles are not supported,
    // insert styling after rendering to ensure adoptedStyles have highest
    // priority.
    if (this._needsShimAdoptedStyleSheets) {
      this._needsShimAdoptedStyleSheets = false;
      (this.constructor as typeof LitElement)._uniqueStyles.forEach((s) => {
        const style = document.createElement('style');
        style.textContent = s.cssText;
        this.renderRoot!.appendChild(style);
      });
    }
  }

  /**
   * Invoked on each update to perform rendering tasks. This method must return
   * a lit-html TemplateResult. Setting properties inside this method will *not*
   * trigger the element to update.
   */
  protected render(): TemplateResult|void {}
}
