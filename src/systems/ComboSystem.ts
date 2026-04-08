export class ComboSystem {
  private combo = 0;
  private comboTimer = 0;
  private readonly comboTimeout = 1200;
  
  getCombo(): number {
    return this.combo;
  }
  
  increment() {
    this.combo++;
    this.comboTimer = 0;
  }
  
  reset() {
    this.combo = 0;
    this.comboTimer = 0;
  }
  
  update(deltaTime: number) {
    if (this.combo > 0) {
      this.comboTimer += deltaTime;
      
      if (this.comboTimer >= this.comboTimeout) {
        this.reset();
      }
    }
  }
  
  getChargeBonus(): number {
    if (this.combo >= 20) return 10;
    if (this.combo >= 10) return 8;
    return 5;
  }
}
