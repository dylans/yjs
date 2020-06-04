
import {
  readID,
  writeID,
  GC,
  getState,
  AbstractStructRef,
  AbstractStruct,
  replaceStruct,
  addStruct,
  addToDeleteSet,
  findRootTypeKey,
  compareIDs,
  getItem,
  getItemCleanEnd,
  getItemCleanStart,
  readContentDeleted,
  readContentBinary,
  readContentJSON,
  readContentAny,
  readContentString,
  readContentEmbed,
  createID,
  readContentFormat,
  readContentType,
  addChangedTypeToTransaction,
  ContentType, ContentDeleted, StructStore, ID, AbstractType, Transaction // eslint-disable-line
} from '../internals.js'

import * as error from 'lib0/error.js'
import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import * as maplib from 'lib0/map.js'
import * as set from 'lib0/set.js'
import * as binary from 'lib0/binary.js'

/**
 * @todo This should return several items
 *
 * @param {StructStore} store
 * @param {ID} id
 * @return {{item:Item, diff:number}}
 */
export const followRedone = (store, id) => {
  /**
   * @type {ID|null}
   */
  let nextID = id
  let diff = 0
  let item
  do {
    if (diff > 0) {
      nextID = createID(nextID.client, nextID.clock + diff)
    }
    item = getItem(store, nextID)
    diff = nextID.clock - item.id.clock
    nextID = item.redone
  } while (nextID !== null && item instanceof Item)
  return {
    item, diff
  }
}

/**
 * Make sure that neither item nor any of its parents is ever deleted.
 *
 * This property does not persist when storing it into a database or when
 * sending it to other peers
 *
 * @param {Item|null} item
 * @param {boolean} keep
 */
export const keepItem = (item, keep) => {
  while (item !== null && item.keep !== keep) {
    item.keep = keep
    item = item.parent._item
  }
}

/**
 * Split leftItem into two items
 * @param {Transaction} transaction
 * @param {Item} leftItem
 * @param {number} diff
 * @return {Item}
 *
 * @function
 * @private
 */
export const splitItem = (transaction, leftItem, diff) => {
  // create rightItem
  const { client, clock } = leftItem.id
  const rightItem = new Item(
    createID(client, clock + diff),
    leftItem,
    createID(client, clock + diff - 1),
    leftItem.right,
    leftItem.rightOrigin,
    leftItem.parent,
    leftItem.parentSub,
    leftItem.content.splice(diff)
  )
  if (leftItem.deleted) {
    rightItem.deleted = true
  }
  if (leftItem.keep) {
    rightItem.keep = true
  }
  if (leftItem.redone !== null) {
    rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff)
  }
  // update left (do not set leftItem.rightOrigin as it will lead to problems when syncing)
  leftItem.right = rightItem
  // update right
  if (rightItem.right !== null) {
    rightItem.right.left = rightItem
  }
  // right is more specific.
  transaction._mergeStructs.push(rightItem)
  // update parent._map
  if (rightItem.parentSub !== null && rightItem.right === null) {
    rightItem.parent._map.set(rightItem.parentSub, rightItem)
  }
  leftItem.length = diff
  return rightItem
}

/**
 * Redoes the effect of this operation.
 *
 * @param {Transaction} transaction The Yjs instance.
 * @param {Item} item
 * @param {Set<Item>} redoitems
 *
 * @return {Item|null}
 *
 * @private
 */
export const redoItem = (transaction, item, redoitems) => {
  const doc = transaction.doc
  const store = doc.store
  const ownClientID = doc.clientID
  const redone = item.redone
  if (redone !== null) {
    return getItemCleanStart(transaction, redone)
  }
  let parentItem = item.parent._item
  /**
   * @type {Item|null}
   */
  let left
  /**
   * @type {Item|null}
   */
  let right
  if (item.parentSub === null) {
    // Is an array item. Insert at the old position
    left = item.left
    right = item
  } else {
    // Is a map item. Insert as current value
    left = item
    while (left.right !== null) {
      left = left.right
      if (left.id.client !== ownClientID) {
        // It is not possible to redo this item because it conflicts with a
        // change from another client
        return null
      }
    }
    if (left.right !== null) {
      left = /** @type {Item} */ (item.parent._map.get(item.parentSub))
    }
    right = null
  }
  // make sure that parent is redone
  if (parentItem !== null && parentItem.deleted === true && parentItem.redone === null) {
    // try to undo parent if it will be undone anyway
    if (!redoitems.has(parentItem) || redoItem(transaction, parentItem, redoitems) === null) {
      return null
    }
  }
  if (parentItem !== null && parentItem.redone !== null) {
    while (parentItem.redone !== null) {
      parentItem = getItemCleanStart(transaction, parentItem.redone)
    }
    // find next cloned_redo items
    while (left !== null) {
      /**
       * @type {Item|null}
       */
      let leftTrace = left
      // trace redone until parent matches
      while (leftTrace !== null && leftTrace.parent._item !== parentItem) {
        leftTrace = leftTrace.redone === null ? null : getItemCleanStart(transaction, leftTrace.redone)
      }
      if (leftTrace !== null && leftTrace.parent._item === parentItem) {
        left = leftTrace
        break
      }
      left = left.left
    }
    while (right !== null) {
      /**
       * @type {Item|null}
       */
      let rightTrace = right
      // trace redone until parent matches
      while (rightTrace !== null && rightTrace.parent._item !== parentItem) {
        rightTrace = rightTrace.redone === null ? null : getItemCleanStart(transaction, rightTrace.redone)
      }
      if (rightTrace !== null && rightTrace.parent._item === parentItem) {
        right = rightTrace
        break
      }
      right = right.right
    }
  }
  const nextClock = getState(store, ownClientID)
  const nextId = createID(ownClientID, nextClock)
  const redoneItem = new Item(
    nextId,
    left, left && left.lastId,
    right, right && right.id,
    parentItem === null ? item.parent : /** @type {ContentType} */ (parentItem.content).type,
    item.parentSub,
    item.content.copy()
  )
  item.redone = nextId
  keepItem(redoneItem, true)
  redoneItem.integrate(transaction)
  return redoneItem
}

/**
 * Abstract class that represents any content.
 */
export class Item extends AbstractStruct {
  /**
   * @param {ID} id
   * @param {Item | null} left
   * @param {ID | null} origin
   * @param {Item | null} right
   * @param {ID | null} rightOrigin
   * @param {AbstractType<any>} parent
   * @param {string | null} parentSub
   * @param {AbstractContent} content
   */
  constructor (id, left, origin, right, rightOrigin, parent, parentSub, content) {
    super(id, content.getLength())
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     * @readonly
     */
    this.origin = origin
    /**
     * The item that is currently to the left of this item.
     * @type {Item | null}
     */
    this.left = left
    /**
     * The item that is currently to the right of this item.
     * @type {Item | null}
     */
    this.right = right
    /**
     * The item that was originally to the right of this item.
     * @readonly
     * @type {ID | null}
     */
    this.rightOrigin = rightOrigin
    /**
     * The parent type.
     * @type {AbstractType<any>}
     * @readonly
     */
    this.parent = parent
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     * @readonly
     */
    this.parentSub = parentSub
    /**
     * Whether this item was deleted or not.
     * @type {Boolean}
     */
    this.deleted = false
    /**
     * If this type's effect is reundone this type refers to the type that undid
     * this operation.
     * @type {ID | null}
     */
    this.redone = null
    /**
     * @type {AbstractContent}
     */
    this.content = content
    /**
     * If true, do not garbage collect this Item.
     */
    this.keep = false
  }

  get countable () {
    return this.content.isCountable()
  }

  /**
   * @param {Transaction} transaction
   */
  integrate (transaction) {
    const store = transaction.doc.store
    const parent = this.parent
    const parentSub = this.parentSub
    const length = this.length
    /**
     * @type {Item|null}
     */
    let left = this.left
    /**
     * @type {Item|null}
     */
    let o
    // set o to the first conflicting item
    if (left !== null) {
      o = left.right
    } else if (parentSub !== null) {
      o = parent._map.get(parentSub) || null
      while (o !== null && o.left !== null) {
        o = o.left
      }
    } else {
      o = parent._start
    }
    // TODO: use something like DeleteSet here (a tree implementation would be best)
    /**
     * @type {Set<Item>}
     */
    const conflictingItems = new Set()
    /**
     * @type {Set<Item>}
     */
    const itemsBeforeOrigin = new Set()
    // Let c in conflictingItems, b in itemsBeforeOrigin
    // ***{origin}bbbb{this}{c,b}{c,b}{o}***
    // Note that conflictingItems is a subset of itemsBeforeOrigin
    while (o !== null && o !== this.right) {
      itemsBeforeOrigin.add(o)
      conflictingItems.add(o)
      if (compareIDs(this.origin, o.origin)) {
        // case 1
        if (o.id.client < this.id.client) {
          left = o
          conflictingItems.clear()
        }
      } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(store, o.origin))) {
        // case 2
        if (o.origin === null || !conflictingItems.has(getItem(store, o.origin))) {
          left = o
          conflictingItems.clear()
        }
      } else {
        break
      }
      o = o.right
    }
    this.left = left
    // reconnect left/right + update parent map/start if necessary
    if (left !== null) {
      const right = left.right
      this.right = right
      left.right = this
    } else {
      let r
      if (parentSub !== null) {
        r = parent._map.get(parentSub) || null
        while (r !== null && r.left !== null) {
          r = r.left
        }
      } else {
        r = parent._start
        parent._start = this
      }
      this.right = r
    }
    if (this.right !== null) {
      this.right.left = this
    } else if (parentSub !== null) {
      // set as current parent value if right === null and this is parentSub
      parent._map.set(parentSub, this)
      if (left !== null) {
        // this is the current attribute value of parent. delete right
        left.delete(transaction)
      }
    }
    // adjust length of parent
    if (parentSub === null && this.countable && !this.deleted) {
      parent._length += length
    }
    addStruct(store, this)
    this.content.integrate(transaction, this)
    // add parent to transaction.changed
    addChangedTypeToTransaction(transaction, parent, parentSub)
    if ((parent._item !== null && parent._item.deleted) || (this.right !== null && parentSub !== null)) {
      // delete if parent is deleted or if this is not the current attribute value of parent
      this.delete(transaction)
    }
  }

  /**
   * Returns the next non-deleted item
   */
  get next () {
    let n = this.right
    while (n !== null && n.deleted) {
      n = n.right
    }
    return n
  }

  /**
   * Returns the previous non-deleted item
   */
  get prev () {
    let n = this.left
    while (n !== null && n.deleted) {
      n = n.left
    }
    return n
  }

  /**
   * Computes the last content address of this Item.
   */
  get lastId () {
    return createID(this.id.client, this.id.clock + this.length - 1)
  }

  /**
   * Try to merge two items
   *
   * @param {Item} right
   * @return {boolean}
   */
  mergeWith (right) {
    if (
      compareIDs(right.origin, this.lastId) &&
      this.right === right &&
      compareIDs(this.rightOrigin, right.rightOrigin) &&
      this.id.client === right.id.client &&
      this.id.clock + this.length === right.id.clock &&
      this.deleted === right.deleted &&
      this.redone === null &&
      right.redone === null &&
      this.content.constructor === right.content.constructor &&
      this.content.mergeWith(right.content)
    ) {
      if (right.keep) {
        this.keep = true
      }
      this.right = right.right
      if (this.right !== null) {
        this.right.left = this
      }
      this.length += right.length
      return true
    }
    return false
  }

  /**
   * Mark this Item as deleted.
   *
   * @param {Transaction} transaction
   */
  delete (transaction) {
    if (!this.deleted) {
      const parent = this.parent
      // adjust the length of parent
      if (this.countable && this.parentSub === null) {
        parent._length -= this.length
      }
      this.deleted = true
      addToDeleteSet(transaction.deleteSet, this.id, this.length)
      maplib.setIfUndefined(transaction.changed, parent, set.create).add(this.parentSub)
      this.content.delete(transaction)
    }
  }

  /**
   * @param {StructStore} store
   * @param {boolean} parentGCd
   */
  gc (store, parentGCd) {
    if (!this.deleted) {
      throw error.unexpectedCase()
    }
    this.content.gc(store)
    if (parentGCd) {
      replaceStruct(store, this, new GC(this.id, this.length))
    } else {
      this.content = new ContentDeleted(this.length)
    }
  }

  /**
   * Transform the properties of this type to binary and write it to an
   * BinaryEncoder.
   *
   * This is called when this Item is sent to a remote peer.
   *
   * @param {encoding.Encoder} encoder The encoder to write data to.
   * @param {number} offset
   */
  write (encoder, offset) {
    const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin
    const rightOrigin = this.rightOrigin
    const parentSub = this.parentSub
    const info = (this.content.getRef() & binary.BITS5) |
      (origin === null ? 0 : binary.BIT8) | // origin is defined
      (rightOrigin === null ? 0 : binary.BIT7) | // right origin is defined
      (parentSub === null ? 0 : binary.BIT6) // parentSub is non-null
    encoding.writeUint8(encoder, info)
    if (origin !== null) {
      writeID(encoder, origin)
    }
    if (rightOrigin !== null) {
      writeID(encoder, rightOrigin)
    }
    if (origin === null && rightOrigin === null) {
      const parent = this.parent
      const parentItem = parent._item
      if (parentItem === null) {
        // parent type on y._map
        // find the correct key
        const ykey = findRootTypeKey(parent)
        encoding.writeVarUint(encoder, 1) // write parentYKey
        encoding.writeVarString(encoder, ykey)
      } else {
        encoding.writeVarUint(encoder, 0) // write parent id
        writeID(encoder, parentItem.id)
      }
      if (parentSub !== null) {
        encoding.writeVarString(encoder, parentSub)
      }
    }
    this.content.write(encoder, offset)
  }
}

/**
 * @param {decoding.Decoder} decoder
 * @param {number} info
 */
const readItemContent = (decoder, info) => contentRefs[info & binary.BITS5](decoder)

/**
 * A lookup map for reading Item content.
 *
 * @type {Array<function(decoding.Decoder):AbstractContent>}
 */
export const contentRefs = [
  () => { throw error.unexpectedCase() }, // GC is not ItemContent
  readContentDeleted,
  readContentJSON,
  readContentBinary,
  readContentString,
  readContentEmbed,
  readContentFormat,
  readContentType,
  readContentAny
]

/**
 * Do not implement this class!
 */
export class AbstractContent {
  /**
   * @return {number}
   */
  getLength () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {Array<any>}
   */
  getContent () {
    throw error.methodUnimplemented()
  }

  /**
   * Should return false if this Item is some kind of meta information
   * (e.g. format information).
   *
   * * Whether this Item should be addressable via `yarray.get(i)`
   * * Whether this Item should be counted when computing yarray.length
   *
   * @return {boolean}
   */
  isCountable () {
    throw error.methodUnimplemented()
  }

  /**
   * @return {AbstractContent}
   */
  copy () {
    throw error.methodUnimplemented()
  }

  /**
   * @param {number} offset
   * @return {AbstractContent}
   */
  splice (offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {AbstractContent} right
   * @return {boolean}
   */
  mergeWith (right) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} transaction
   * @param {Item} item
   */
  integrate (transaction, item) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {Transaction} transaction
   */
  delete (transaction) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {StructStore} store
   */
  gc (store) {
    throw error.methodUnimplemented()
  }

  /**
   * @param {encoding.Encoder} encoder
   * @param {number} offset
   */
  write (encoder, offset) {
    throw error.methodUnimplemented()
  }

  /**
   * @return {number}
   */
  getRef () {
    throw error.methodUnimplemented()
  }
}

/**
 * @private
 */
export class ItemRef extends AbstractStructRef {
  /**
   * @param {decoding.Decoder} decoder
   * @param {ID} id
   * @param {number} info
   */
  constructor (decoder, id, info) {
    super(id)
    /**
     * The item that was originally to the left of this item.
     * @type {ID | null}
     */
    this.left = (info & binary.BIT8) === binary.BIT8 ? readID(decoder) : null
    /**
     * The item that was originally to the right of this item.
     * @type {ID | null}
     */
    this.right = (info & binary.BIT7) === binary.BIT7 ? readID(decoder) : null
    const canCopyParentInfo = (info & (binary.BIT7 | binary.BIT8)) === 0
    const hasParentYKey = canCopyParentInfo ? decoding.readVarUint(decoder) === 1 : false
    /**
     * If parent = null and neither left nor right are defined, then we know that `parent` is child of `y`
     * and we read the next string as parentYKey.
     * It indicates how we store/retrieve parent from `y.share`
     * @type {string|null}
     */
    this.parentYKey = canCopyParentInfo && hasParentYKey ? decoding.readVarString(decoder) : null
    /**
     * The parent type.
     * @type {ID | null}
     */
    this.parent = canCopyParentInfo && !hasParentYKey ? readID(decoder) : null
    /**
     * If the parent refers to this item with some kind of key (e.g. YMap, the
     * key is specified here. The key is then used to refer to the list in which
     * to insert this item. If `parentSub = null` type._start is the list in
     * which to insert to. Otherwise it is `parent._map`.
     * @type {String | null}
     */
    this.parentSub = canCopyParentInfo && (info & binary.BIT6) === binary.BIT6 ? decoding.readVarString(decoder) : null
    const missing = this._missing
    // Only add items to missing if they don't preceed this item (indicating that it has already been added).
    // @todo Creating missing items could be done outside this constructor
    if (this.left !== null && this.left.client !== id.client) {
      missing.push(this.left)
    }
    if (this.right !== null && this.right.client !== id.client) {
      missing.push(this.right)
    }
    if (this.parent !== null) {
      missing.push(this.parent)
    }
    /**
     * @type {AbstractContent}
     */
    this.content = readItemContent(decoder, info)
    this.length = this.content.getLength()
  }

  /**
   * @param {Transaction} transaction
   * @param {StructStore} store
   * @param {number} offset
   * @return {Item|GC}
   */
  toStruct (transaction, store, offset) {
    if (offset > 0) {
      this.id.clock += offset
      this.left = createID(this.id.client, this.id.clock - 1)
      this.content = this.content.splice(offset)
      this.length -= offset
    }

    const left = this.left === null ? null : getItemCleanEnd(transaction, store, this.left)
    const right = this.right === null ? null : getItemCleanStart(transaction, this.right)
    const parentId = this.parent
    let parent = null
    let parentSub = this.parentSub
    if (parentId !== null) {
      const parentItem = getItem(store, parentId)
      // Edge case: toStruct is called with an offset > 0. In this case left is defined.
      // Depending in which order structs arrive, left may be GC'd and the parent not
      // deleted. This is why we check if left is GC'd. Strictly we don't have
      // to check if right is GC'd, but we will in case we run into future issues
      if (!parentItem.deleted && (left === null || left.constructor !== GC) && (right === null || right.constructor !== GC)) {
        parent = /** @type {ContentType} */ (parentItem.content).type
      }
    } else if (this.parentYKey !== null) {
      parent = transaction.doc.get(this.parentYKey)
    } else if (left !== null) {
      if (left.constructor !== GC) {
        parent = left.parent
        parentSub = left.parentSub
      }
    } else if (right !== null) {
      if (right.constructor !== GC) {
        parent = right.parent
        parentSub = right.parentSub
      }
    } else {
      throw error.unexpectedCase()
    }

    return parent === null
      ? new GC(this.id, this.length)
      : new Item(
        this.id,
        left,
        left && left.lastId,
        right,
        right && right.id,
        parent,
        parentSub,
        this.content
      )
  }
}
