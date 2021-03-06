import { Log } from '@microsoft/sp-core-library';
import { override } from '@microsoft/decorators';
import {
  BaseFieldCustomizer,
  IFieldCustomizerCellEventParameters
} from '@microsoft/sp-listview-extensibility';

import * as $ from 'jquery';
import "jqueryui";
import { IOrderedRow } from './IOrderedRow';
import { IChangedRow } from './IChangedRow';
import { ISpfxItemOrderFieldCustomizerProperties } from './ISpfxItemOrderFieldCustomizerProperties';
import { SPPermission } from "@microsoft/sp-page-context";
import pnp from "sp-pnp-js";

import * as strings from 'SpfxItemOrderFieldCustomizerStrings';
import styles from './SpfxItemOrderFieldCustomizer.module.scss';

//Constants (simplifies updates should these values change)
const TIMEOUTDURATION_INIT: number = 100;
const LISTPAGECONTAINER: string = '.ms-List-page';
const LISTROWCONTAINER: string = '.ms-List-cell';
const INDICATORICONCLASS: string = 'ms-Icon--Pin';
const LOADINGICONCLASS: string = 'ms-Icon--Refresh';
const DISABLEDICONCLASS: string = 'ms-Icon--Unpin';
const LOG_SOURCE: string = 'SpfxItemOrderFieldCustomizer';

export default class SpfxItemOrderFieldCustomizer
  extends BaseFieldCustomizer<ISpfxItemOrderFieldCustomizerProperties> {

  private _timeoutId_Init: number;
  private _rowOrder: Array<number>;
  private _rowMap: Array<IOrderedRow>;
  private _orderField: string;


  @override
  public onInit(): Promise<void> {

    //By default, the internal Order column is used, but
    // a different (number) column can be specified through the
    // ClientSideComponentProperties instead
    this._orderField = this.properties.OrderField || 'Order';

    //Initialize the row map
    this._rowMap = new Array<IOrderedRow>();

    //Provide PnP JS-Core with the proper context (needed in SPFx Components)
    return super.onInit().then(_ => {
      pnp.setup({
        spfxContext: this.context
      });
    });
  }

  @override
  public onRenderCell(event: IFieldCustomizerCellEventParameters): void {
    
    //Cancel the previous timeout (if any)
    if(this._timeoutId_Init) {
      clearTimeout(this._timeoutId_Init);
    }

    //Provide an icon for dragging (actually, the whole row can be dragged, but a UI hint is helpful)
    event.domElement.classList.add('ms-font-l'); //increase the font-size
    event.domElement.classList.add(`${styles.SpfxItemOrder}`); //add our base CSS class

    if(this.context.pageContext.list.permissions.hasPermission(SPPermission.editListItems)) {
      event.domElement.innerHTML = `<i class="ms-Icon ${INDICATORICONCLASS} ${styles.reorderField}" aria-hidden="true"></i>`;
      
      //Track the Ids and Order values of each row (so that they can be referenced later)
      this._rowMap.push({
        Id: event.listItem.getValueByName('ID'),
        Order: event.listItem.getValueByName(this._orderField)
      });
  
      //Reset timeout (only needed since there isn't an official onCellsRendered event)
      this._timeoutId_Init = setTimeout(this.onCellsRendered.bind(this), TIMEOUTDURATION_INIT);
    } else {
      event.domElement.innerHTML = `<i class="ms-Icon ${DISABLEDICONCLASS}" aria-hidden="true" title="Insufficient Permissions!"></i>`;
    }
    
  }

  /** Once all the cells are rendered (icons), and the key values stored in the
   *   internal rowMap object, we setup the jQuery UI Sortable interface
   */
  public onCellsRendered(): void {

    //jQuery document ready
    $(document).ready(() => {

      //Apply jQuery UI sortable to the item rows
      // see http://jqueryui.com/sortable for more details
      $(LISTPAGECONTAINER).sortable({
        stop: this.onOrderChanged.bind(this) //This fires whenever a row is dragged and dropped within our list
      });

      //Store the current row order (so we can track what changes)
      this._rowOrder = SpfxItemOrderFieldCustomizer.getRowOrder();

    });

  }

  @override
  public onDisposeCell(event: IFieldCustomizerCellEventParameters): void {
    super.onDisposeCell(event);
  }

  /** Handles the jQuery UI Sortable stopsort event */
  public onOrderChanged(e: JQueryEventObject, ui: JQueryUI.SortableUIParams): void {

    //Disable reordering
    $(LISTPAGECONTAINER).sortable('disable');

    //Grab the current row order
    let newOrder: Array<number> = SpfxItemOrderFieldCustomizer.getRowOrder();

    //Look for any changes
    if(SpfxItemOrderFieldCustomizer.hasChanged(this._rowOrder, newOrder)) {

      //Save the changes to the list
      this.saveChanges();

    } else {

      //No order changes, so turn the reordering back on
      $(LISTPAGECONTAINER).sortable('enable');

    }

  }

  /** Saves the new Order value for all reordered list items */
  public saveChanges(): void {

    //Grab the current row order
    let newOrder: Array<number> = SpfxItemOrderFieldCustomizer.getRowOrder();

    //Find the changed rows
    let dirtyRows: Array<IChangedRow> = SpfxItemOrderFieldCustomizer.changedRows(this._rowOrder, newOrder);

    //Setup a batch so that we can minimize the update calls needed
    let itemBatch: any = pnp.sp.createBatch();

    dirtyRows.forEach((row: IChangedRow) => {

      //Add a loading indicator to the row to provide status to the user
      SpfxItemOrderFieldCustomizer.showLoading(row.listIndex);

      //Swaps the Order value for the changed rows using the values first stored in the _rowMap
      let props: any = {};
      props[this._orderField] = this._rowMap[row.position].Order;
      pnp.sp.web.lists.getById(this.context.pageContext.list.id.toString()).items.getById(this._rowMap[row.listIndex].Id).inBatch(itemBatch).update(props);

    });

    //Execute the batch
    itemBatch.execute()
      .then(() => {

        //Remove the loading indicators
        SpfxItemOrderFieldCustomizer.hideLoading();

        //Reset the internal row order tracking so we can track new changes
        this._rowOrder = newOrder;
        
        //Turn reordering back on
        $(LISTPAGECONTAINER).sortable('enable');

      })
      .catch((error: any): void => {
        Log.error(LOG_SOURCE, error);
        if(console && console.log) {
          console.log(error);
        }
      });

  }


  /*----------------
    STATIC METHODS
  ----------------*/

  /** Grabs the current row order from the paged listview
   *  This returns an array of the original list-index value in the order they currently are in
   */
  public static getRowOrder(): Array<number> {

    //The jQuery UI @types does not include the method to specify the attribute
    // used in the toArray method, so we cast it to <any> first
    //The initial results are string values so we map to an array of integers
    // since this makes referencing by index much easier
    return (<any>$(LISTPAGECONTAINER)).sortable('toArray', {
      attribute: 'data-list-index'
    }).map((value: string) => {
      return parseInt(value);
    });

  }

  /** Quickly compares order arrays to see if any of the values are different */
  public static hasChanged(prevOrder: Array<number>, newOrder: Array<number>): boolean {

    for(let i: number = 0; i < newOrder.length; i++) {
      if(newOrder[i] !== prevOrder[i]) {
        return true; //Changed!
      }
    }
    return false; //Same!

  }

  /** Evalues the order arrays and only returns those rows which have changed */
  public static changedRows(prevOrder: Array<number>, newOrder: Array<number>): Array<IChangedRow> {
    let diffRows: Array<IChangedRow> = new Array<IChangedRow>();

    for(let i: number = 0; i < newOrder.length; i++) {
      if(newOrder[i] !== prevOrder[i]) {
        
        //Stores the original listIndex value along with its current position
        diffRows.push({
          listIndex: newOrder[i],
          position: i
        });

      }
    }

    return diffRows;
  }

  /** Shows the loading indicator for the specific row */
  public static showLoading(listIndex: number): void {

    //jQuery selector finds the row with the matching list-index value
    // then finds our field within its descendents
    $(LISTROWCONTAINER + `[data-list-index=${listIndex}] .${styles.reorderField}`)
      .removeClass(INDICATORICONCLASS)
      .addClass(LOADINGICONCLASS)
      .addClass(styles.spinning);

  }

  /** Returns all loading indicators back to the original icon */
  public static hideLoading(): void {

    //jQuery selector just finds all of our fields that are
    // currently showing the loading indicator 
    $(`.${styles.reorderField}.${LOADINGICONCLASS}`)
      .removeClass(LOADINGICONCLASS)
      .removeClass(styles.spinning)
      .addClass(INDICATORICONCLASS);

  }
}
