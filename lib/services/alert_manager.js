import { PureService } from '@Lib/services/pure_service';

export class SNAlertManager extends PureService {

  async alert(params) {
    return new Promise((resolve, reject) => {
      window.alert(params.text);
      resolve();
    });
  }

  async confirm(params) {
    return new Promise((resolve, reject) => {
      if (window.confirm(params.text)) {
        resolve();
      } else {
        // eslint-disable-next-line prefer-promise-reject-errors
        reject();
      }
    });
  }

}